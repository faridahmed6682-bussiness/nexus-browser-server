'use strict';
/**
 * Downloads module for the Nexus browser-worker server.
 *
 * captureDownload(page, url, opts) navigates `page` to `url` and captures
 * the file the browser downloads, returning it as base64 so the caller
 * (the Nexus Android app, via the worker API) can upload it to Firebase
 * Storage and hand the user a share link.
 *
 * The server itself NEVER talks to Firebase and NEVER keeps the file:
 * the temp file is always deleted (finally block), whether the capture
 * succeeds, is too large, or fails.
 *
 * Contract:
 *   captureDownload(page, url, { maxBytes = 8 * 1024 * 1024 })
 *     -> { base64, filename, mime, size }        file captured, within limit
 *     -> { tooLarge: true, size, filename }      file exceeded maxBytes
 *     -> { notAFile: true, url }                 plain page, no download in 20s
 *
 * Only Node built-ins (fs, os, path, crypto) + the Playwright `page`
 * object passed in. No new dependencies.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DOWNLOAD_WAIT_MS = 20000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

// Small extension -> MIME map. Unknown extensions fall back to
// application/octet-stream; the app can sniff/override from the filename.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.apk': 'application/vnd.android.package-archive',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.epub': 'application/epub+zip',
};

function mimeForFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Strip any directory components / control chars from a server-suggested
// filename so it can never escape os.tmpdir().
function safeBasename(name) {
  const base = path.basename(String(name || 'download').replace(/[\u0000-\u001f\u007f]/g, ''));
  return base && base !== '.' && base !== '..' ? base : 'download';
}

function tempPathFor(filename) {
  const rand = crypto.randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), 'nexus-dl-' + rand + '-' + safeBasename(filename));
}

async function unlinkQuiet(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    // Already gone / never created — nothing to clean up.
  }
}

/**
 * Navigate to `url` and capture the resulting download.
 *
 * @param {object} page - a Playwright Page (from a fresh browser context)
 * @param {string} url  - URL to navigate to
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=8*1024*1024] - reject files larger than this
 * @returns {Promise<{base64,filename,mime,size}|{tooLarge,size,filename}|{notAFile,url}>}
 */
async function captureDownload(page, url, opts) {
  if (!page || typeof page.waitForEvent !== 'function') {
    throw new TypeError('captureDownload requires a Playwright page');
  }
  if (!url || typeof url !== 'string') {
    throw new TypeError('captureDownload requires a url string');
  }
  const maxBytes = (opts && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0)
    ? Math.floor(opts.maxBytes)
    : DEFAULT_MAX_BYTES;

  // Fallback for servers that answer a navigation with a file body instead
  // of triggering Playwright's download event: remember the first response
  // carrying `Content-Disposition: attachment`.
  let attachmentResponse = null;
  const onResponse = (response) => {
    if (attachmentResponse) return;
    try {
      const cd = response.headers()['content-disposition'] || '';
      if (/attachment/i.test(cd)) attachmentResponse = response;
    } catch (err) {
      // Headers unreadable — ignore, the download event is the main path.
    }
  };
  page.on('response', onResponse);

  try {
    // Register the download listener BEFORE navigating: a fast download
    // event could otherwise fire before waitForEvent is listening.
    const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_WAIT_MS })
      .catch(() => null);

    // Start navigation without awaiting it: navigating to a file URL may
    // not resolve normally (the download takes over), and awaiting it here
    // would hang the 20s wait below.
    const gotoPromise = page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: DOWNLOAD_WAIT_MS,
    }).catch(() => null);

    // The download event is the normal path (direct file URL, or a link /
    // button that triggers a download after navigation).
    const download = await downloadPromise;

    if (download) {
      const filename = safeBasename(download.suggestedFilename() || 'download');
      const tmpPath = tempPathFor(filename);
      try {
        await download.saveAs(tmpPath);
        const { size } = await fs.promises.stat(tmpPath);
        if (size > maxBytes) {
          return { tooLarge: true, size, filename };
        }
        const buf = await fs.promises.readFile(tmpPath);
        return {
          base64: buf.toString('base64'),
          filename,
          mime: mimeForFilename(filename),
          size: buf.length,
        };
      } finally {
        await unlinkQuiet(tmpPath);
      }
    }

    // No download event. If a response carried an attachment disposition,
    // read its body directly instead of reporting "not a file".
    if (attachmentResponse) {
      const cd = attachmentResponse.headers()['content-disposition'] || '';
      const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
      const filename = safeBasename(match ? decodeURIComponent(match[1].replace(/"$/, '')) : 'download');
      const buf = await attachmentResponse.body().catch(() => null);
      if (buf) {
        if (buf.length > maxBytes) {
          return { tooLarge: true, size: buf.length, filename };
        }
        return {
          base64: buf.toString('base64'),
          filename,
          mime: mimeForFilename(filename),
          size: buf.length,
        };
      }
    }

    // Plain page (or a link that never started a download): not a file.
    // Let the in-flight navigation settle briefly so the page is left in a
    // usable state for the caller, but never block on it.
    await Promise.race([gotoPromise, page.waitForTimeout(1000)]).catch(() => {});
    return { notAFile: true, url };
  } finally {
    page.off('response', onResponse);
  }
}

module.exports = { captureDownload };
