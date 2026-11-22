'use strict';
/**
 * Small cropped JPEG screenshots for the Nexus browser worker.
 *
 * Design goal: keep every screenshot small enough to send back to the
 * Android app over a free-tier connection and feed to a vision model
 * without blowing RAM. Smallness comes from three things:
 *   1. cropping — only the requested element/region is captured,
 *      never the full page;
 *   2. JPEG at quality 50 (never above 60) instead of PNG;
 *   3. the caller requesting small regions (maxWidth 480 by default).
 *
 * NOTE — true downscaling is NOT done here: Playwright has no built-in
 * image resize, and this module adds no image library (no sharp, no
 * paid libs) by design. If a full-viewport shot is requested, cap the
 * viewport at 800x600 first via page.setViewportSize() before shooting
 * and restore the original viewport afterwards — see the code below.
 * That bounds the pixel count (800*600 = 480k px) so even a worst-case
 * full-viewport JPEG stays small.
 */

const DEFAULT_QUALITY = 50;
const MAX_QUALITY = 60;
const DEFAULT_MAX_WIDTH = 480;
const FULL_VIEWPORT_CAP = { width: 800, height: 600 };

// BN+EN error used when a requested element cannot be found.
function elementNotFoundError(selector) {
  return new Error(
    'screenshot: element not found — উপাদানটি পাওয়া যায়নি: ' + selector,
  );
}

/**
 * Take a small cropped JPEG screenshot of a page region.
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {string} [opts.selector]  CSS selector — its bounding box
 *   becomes the clip. If the element is not found, throws a clear
 *   BN+EN error. Takes precedence over opts.clip.
 * @param {{x:number,y:number,width:number,height:number}} [opts.clip]
 *   explicit region (CSS px); clamped inside the viewport.
 * @param {number} [opts.quality=50]  JPEG quality, clamped to 1..60.
 * @param {number} [opts.maxWidth=480]  if the clip is wider than this,
 *   the clip is narrowed (centred) to maxWidth — cropping, not
 *   downscaling (see module header).
 * @returns {Promise<{jpegBase64:string,width:number,height:number,bytes:number}>}
 */
async function takeSmallScreenshot(page, opts) {
  const options = opts || {};
  const quality = Math.min(
    MAX_QUALITY,
    Math.max(1, Math.floor(options.quality == null ? DEFAULT_QUALITY : options.quality)),
  );
  const maxWidth = Math.max(
    1,
    Math.floor(options.maxWidth == null ? DEFAULT_MAX_WIDTH : options.maxWidth),
  );

  const viewport = page.viewportSize() || { width: 1280, height: 800 };

  let clip = null;
  let cappedViewport = false;
  let originalViewport = null;

  if (options.selector) {
    const locator = page.locator(options.selector);
    const count = await locator.count().catch(() => 0);
    if (count === 0) throw elementNotFoundError(options.selector);
    const box = await locator.first().boundingBox();
    if (!box) throw elementNotFoundError(options.selector);
    clip = { x: box.x, y: box.y, width: box.width, height: box.height };
  } else if (options.clip) {
    clip = {
      x: options.clip.x,
      y: options.clip.y,
      width: options.clip.width,
      height: options.clip.height,
    };
  }

  if (clip) {
    // Clamp the clip inside the viewport (Playwright throws on
    // out-of-bounds clips).
    clip.x = Math.max(0, Math.min(clip.x, viewport.width - 1));
    clip.y = Math.max(0, Math.min(clip.y, viewport.height - 1));
    clip.width = Math.max(1, Math.min(clip.width, viewport.width - clip.x));
    clip.height = Math.max(1, Math.min(clip.height, viewport.height - clip.y));
    // Narrow an over-wide clip to maxWidth, centred on the original.
    if (clip.width > maxWidth) {
      const excess = clip.width - maxWidth;
      clip.x = Math.min(clip.x + excess / 2, viewport.width - maxWidth);
      clip.width = maxWidth;
    }
  } else {
    // No region requested: full-viewport shot. Cap the viewport at
    // 800x600 first (bounds the pixel count — see module header),
    // shoot, then restore the original viewport.
    if (viewport.width > FULL_VIEWPORT_CAP.width || viewport.height > FULL_VIEWPORT_CAP.height) {
      originalViewport = viewport;
      await page.setViewportSize(FULL_VIEWPORT_CAP);
      cappedViewport = true;
    }
    clip = {
      x: 0,
      y: 0,
      width: Math.min(viewport.width, FULL_VIEWPORT_CAP.width),
      height: Math.min(viewport.height, FULL_VIEWPORT_CAP.height),
    };
  }

  try {
    const buf = await page.screenshot({ type: 'jpeg', quality, clip });
    return {
      jpegBase64: buf.toString('base64'),
      width: Math.round(clip.width),
      height: Math.round(clip.height),
      bytes: buf.length,
    };
  } finally {
    if (cappedViewport && originalViewport) {
      await page.setViewportSize(originalViewport).catch(() => {});
    }
  }
}

module.exports = { takeSmallScreenshot };
