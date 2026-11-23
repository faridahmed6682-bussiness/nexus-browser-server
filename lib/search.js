'use strict';
/**
 * Web search for Nexus: Google Custom Search (primary, free plan)
 * with DuckDuckGo HTML as the automatic fallback.
 *
 * Order (user rule, 2026-11-23): Google Custom Search free plan FIRST;
 * when the free quota runs out, DuckDuckGo runs again. DuckDuckGo stays
 * the browser homepage/default — this endpoint only changes HOW a
 * search query is answered, never the browser's default page.
 *
 * Free plan facts (Google Programmable Search Engine / Custom Search API):
 *  - 100 search queries/day free, then $5 per 1,000 queries.
 *  - Needs two values the USER creates in Google Cloud (the server can
 *    never create them): a Programmable Search Engine ID (`cx`) and an
 *    API key with the Custom Search API enabled. Env vars:
 *    GOOGLE_CSE_CX, GOOGLE_CSE_API_KEY (see .env.example + README).
 *  - When either is unset, search works with DuckDuckGo only and the
 *    response says so (provider "duckduckgo", quotaRemaining null).
 *
 * Daily quota: max 100 CSE calls/day, counted in a small JSON state
 * file (search-quota.json, gitignored runtime state — same pattern as
 * github-installations.json) plus an in-memory counter. The count resets
 * at midnight UTC. A failed CSE call still counts (Google bills the
 * request), so the counter is recorded BEFORE the call is made.
 *
 * Fallback triggers (any of them → DuckDuckGo HTML, plain HTTP, no JS,
 * no Playwright — the html endpoint needs no browser at all):
 *  - CSE keys unset, or the 100/day quota already used up;
 *  - CSE returns any 4xx/5xx, or the request fails (network/timeout).
 *
 * Safety: the CSE key is NEVER logged and NEVER returned. Logs carry
 * only the provider, the HTTP status and the remaining quota. The CSE
 * request URL (which carries the key as a query param) is never logged.
 *
 * No new npm dependencies: Node 20 built-ins + global fetch only.
 */

const fs = require('fs');
const path = require('path');

const CSE_DAILY_LIMIT = 100;
const CSE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const CSE_TIMEOUT_MS = 15000;
// Test override only (smoke tests): base URL of the DuckDuckGo HTML
// endpoint. Leave unset in production.
const DDG_HTML_BASE_URL = process.env.DDG_HTML_BASE_URL || 'https://html.duckduckgo.com/html/';
const DDG_TIMEOUT_MS = 15000;
const MAX_RESULTS = 10;
const QUOTA_STATE_FILE = path.join(__dirname, '..', 'search-quota.json');

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Daily CSE quota tracker. `stateFile` is the JSON state file
 * ({date: "YYYY-MM-DD", used: N}); it is written atomically (tmp +
 * rename) on every change, like github-installations.json. The day
 * rolls over at midnight UTC — the first call after midnight resets
 * the count to 0. Exported for the smoke tests (no real quota spent).
 */
function createQuotaTracker(stateFile) {
  let state = { date: todayUtc(), used: 0 };

  function load() {
    try {
      if (!fs.existsSync(stateFile)) return;
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (data && typeof data.date === 'string' && Number.isInteger(data.used) && data.used >= 0) {
        state = { date: data.date, used: data.used };
      }
    } catch (_) {
      // Corrupt / unreadable state file: start fresh, never crash search.
      state = { date: todayUtc(), used: 0 };
    }
  }

  function save() {
    try {
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, stateFile);
    } catch (_) {
      // Ephemeral filesystems (Railway/Render without a volume) may
      // refuse writes — the in-memory count still works for this run.
    }
  }

  function refresh() {
    if (state.date !== todayUtc()) {
      state = { date: todayUtc(), used: 0 };
      save();
    }
  }

  load();

  return {
    /** CSE calls left today (0–100). */
    remaining() {
      refresh();
      return Math.max(0, CSE_DAILY_LIMIT - state.used);
    },
    /** CSE calls already made today. */
    usedToday() {
      refresh();
      return state.used;
    },
    /** True when at least one CSE call is left today. */
    canUse() {
      return this.remaining() > 0;
    },
    /** Record one CSE call (called BEFORE the request — Google bills it). */
    recordUse() {
      refresh();
      state.used += 1;
      save();
    },
    status() {
      refresh();
      return { configured: isCseConfigured(), usedToday: state.used, remaining: Math.max(0, CSE_DAILY_LIMIT - state.used), date: state.date, dailyLimit: CSE_DAILY_LIMIT };
    },
  };
}

function isCseConfigured() {
  return Boolean((process.env.GOOGLE_CSE_API_KEY || '') && (process.env.GOOGLE_CSE_CX || ''));
}

// One tracker for the process (in-memory + search-quota.json).
const defaultTracker = createQuotaTracker(QUOTA_STATE_FILE);

/** Public status for the boot log — no keys, only counts. */
function searchStatus() {
  return defaultTracker.status();
}

// ---------------------------------------------------------------------------
// Google Custom Search
// ---------------------------------------------------------------------------
async function searchWithGoogle(query) {
  const params = new URLSearchParams({
    key: process.env.GOOGLE_CSE_API_KEY,
    cx: process.env.GOOGLE_CSE_CX,
    q: query,
    num: String(MAX_RESULTS),
  });
  // Never log this URL — it carries the CSE key as a query param.
  const res = await fetch(CSE_ENDPOINT + '?' + params.toString(), {
    signal: AbortSignal.timeout(CSE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error('Google Custom Search HTTP ' + res.status);
  }
  const data = await res.json().catch(() => ({}));
  const items = Array.isArray(data.items) ? data.items : [];
  return items
    .filter((it) => it && typeof it.link === 'string' && it.link)
    .slice(0, MAX_RESULTS)
    .map((it) => ({
      title: typeof it.title === 'string' ? it.title : '',
      url: it.link,
      snippet: typeof it.snippet === 'string' ? it.snippet : '',
    }));
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML fallback (plain HTTP, no JS, no Playwright)
// ---------------------------------------------------------------------------
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(s) {
  return decodeHtmlEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * DDG wraps result links: //duckduckgo.com/l/?uddg=<urlencoded target>.
 * Decode the `uddg` param to get the real URL; plain links pass through.
 */
function decodeDuckDuckGoHref(href) {
  if (!href) return '';
  const h = href.trim();
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return '';
    }
  }
  return h.startsWith('//') ? 'https:' + h : h;
}

/**
 * Parse html.duckduckgo.com/html/ results. Each result block has a
 * `<a class="result__a" href="...">title</a>` and a matching
 * `<a class="result__snippet">snippet</a>` in the same order, so links
 * and snippets are zipped by position. Exported for the smoke tests.
 */
function parseDuckDuckGoHtml(html) {
  const links = [];
  const snippets = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ url: decodeDuckDuckGoHref(m[1]), title: stripTags(m[2]) });
  }
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]));
  }
  const results = [];
  for (let i = 0; i < links.length && results.length < MAX_RESULTS; i += 1) {
    const link = links[i];
    if (!link.url || !link.title) continue;
    results.push({ title: link.title, url: link.url, snippet: snippets[i] || '' });
  }
  return results;
}

async function searchWithDuckDuckGo(query, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const url = DDG_HTML_BASE_URL + '?q=' + encodeURIComponent(query);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
  };
  // DDG answers bot-suspect requests with HTTP 202 + a bare "DuckDuckGo"
  // page (no results, no captcha text) — and rate-limits bursts from one
  // IP, so a first attempt can 202 while the next one passes. Retry once
  // after 2 s before giving up; on a second block the caller (the route)
  // answers 502 and the app falls back to the browser-worker DDG URL
  // (Playwright Chromium — a different fingerprint that may pass).
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(DDG_TIMEOUT_MS),
      headers,
    });
    if (res.status !== 200) {
      if (attempt === 1) {
        console.warn('[search] duckduckgo HTTP ' + res.status + ', retrying once');
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error('DuckDuckGo HTTP ' + res.status);
    }
    const html = await res.text();
    const results = parseDuckDuckGoHtml(html);
    if (results.length === 0 && isDuckDuckGoBlockPage(html)) {
      if (attempt === 1) {
        console.warn('[search] duckduckgo served a bot-check page, retrying once');
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error('DuckDuckGo blocked the request (bot check)');
    }
    return results;
  }
  throw new Error('DuckDuckGo blocked the request (bot check)');
}

/**
 * True when a DDG HTML page is a bot-check/empty page, not a genuine
 * "no results" page. A genuine no-results page keeps the query in its
 * title ("<query> at DuckDuckGo"); the block page has the bare title
 * "DuckDuckGo" and no result links at all. Exported for the smoke tests.
 */
function isDuckDuckGoBlockPage(html) {
  if (/captcha|anomaly|if this persists/i.test(html)) return true;
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  return title.trim() === 'DuckDuckGo' && !/result__a/.test(html);
}

// ---------------------------------------------------------------------------
// Search: Google first, DuckDuckGo on any failure / quota / no keys.
// ---------------------------------------------------------------------------
/**
 * @param {string} query — the search query (non-empty, already trimmed).
 * @param {object} [opts] — { tracker } test override (default: the
 *   process tracker backed by search-quota.json).
 * @returns {Promise<{provider: "google"|"duckduckgo", results: Array<{title,url,snippet}>, quotaRemaining: number|null}>}
 * @throws when BOTH providers fail — the caller answers 502.
 */
async function searchWeb(query, opts = {}) {
  const tracker = opts.tracker || defaultTracker;
  const configured = isCseConfigured();

  if (configured && tracker.canUse()) {
    try {
      tracker.recordUse();
      const results = await searchWithGoogle(query);
      const remaining = tracker.remaining();
      console.log('[search] google ok, quota remaining ' + remaining + '/' + CSE_DAILY_LIMIT + ' today');
      return { provider: 'google', results, quotaRemaining: remaining };
    } catch (err) {
      console.warn('[search] google failed (' + (err && err.message ? err.message : err) + '), falling back to duckduckgo');
    }
  } else if (configured) {
    console.log('[search] google daily quota used up (' + CSE_DAILY_LIMIT + '/' + CSE_DAILY_LIMIT + '), using duckduckgo');
  } else {
    console.log('[search] google not configured, using duckduckgo');
  }

  const results = await searchWithDuckDuckGo(query, opts.fetchImpl);
  return {
    provider: 'duckduckgo',
    results,
    quotaRemaining: configured ? tracker.remaining() : null,
  };
}

module.exports = {
  CSE_DAILY_LIMIT,
  createQuotaTracker,
  isDuckDuckGoBlockPage,
  parseDuckDuckGoHtml,
  searchStatus,
  searchWeb,
};
