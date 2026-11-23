'use strict';
/**
 * Web search for Nexus: 11-leg free no-card chain.
 * lib/free-providers.js supplies Tavily, Exa, Firecrawl, Marginalia,
 * SearXNG, Mojeek, Bing RSS and Wikipedia; this file keeps Brave,
 * Google Custom Search and DuckDuckGo HTML.
 *
 * Order (user rule, 2026-11-24 — free, no-card providers first):
 *   1. Tavily (key-gated) -> 2. Exa (key-gated) -> 3. Firecrawl
 *   (key-gated) -> 4. Marginalia (no key) -> 5. SearXNG (self-hosted,
 *   SEARXNG_URL) -> 6. Mojeek (no key) -> 7. Bing RSS (no key)
 *   -> 8. Brave (key-gated) -> 9. Google CSE (key-gated, quota)
 *   -> 10. DuckDuckGo HTML (no key) -> 11. Wikipedia (no key,
 *   last resort). First leg returning non-empty results wins.
 *   A leg is SKIPPED (not attempted) when its key/env is unset; an
 *   error or an empty answer falls through to the next leg.
 *   DuckDuckGo stays the browser homepage/default — this endpoint
 *   only changes HOW a search query is answered, never the
 *   browser's default page.
 *
 * Free-plan facts (keyed legs: free keys, email signup, no card):
 *  - Tavily: free-tier key at https://tavily.com (search API).
 *  - Exa: free-tier key at https://exa.ai (search API).
 *  - Firecrawl: free-tier key at https://firecrawl.dev (search API).
 *  - Marginalia: no key — https://search.marginalia.nu (small-web
 *    index; results skew to small/independent sites, not the whole web).
 *  - SearXNG: no key, but needs a self-hosted instance URL
 *    (SEARXNG_URL); unset = leg skipped.
 *  - Mojeek: no key — HTML scrape of https://www.mojeek.com.
 *  - Bing RSS: no key — https://www.bing.com/search?q=...&format=rss.
 *  - Wikipedia: no key — https://en.wikipedia.org/w/api.php
 *    (opensearch); encyclopaedia summaries, not general web results.
 *
 * HONEST NOTES:
 *  - Brave is card-gated, so its leg is dormant without a key:
 *    Brave's FAQ (brave.com/search/api/) says a credit card IS
 *    required at signup even for the free plan (anti-fraud, not
 *    charged; free plan $5/mo ~ 1,000 requests). The user has NO
 *    card, so a real Brave key may be unobtainable — that is a
 *    signup problem, not a code problem. Until a key exists, the
 *    Brave leg is skipped. The key is sent as a header, NEVER in
 *    the URL, and never logged. Brave returns no daily quota
 *    counter, so quotaRemaining is null for provider "brave".
 *  - Google CSE whole-web search is deprecated for NEW
 *    Programmable Search Engines — the engine the user created
 *    searches ONLY example.com (a forced placeholder; the switch
 *    is greyed out), so the CSE leg answers example.com-only
 *    results unless domains are added to the engine. The env vars
 *    (GOOGLE_CSE_API_KEY, GOOGLE_CSE_CX) are NOT set on the hosts,
 *    so today this leg is skipped entirely.
 *  - Mojeek / Bing scrape legs may be blocked from datacenter IPs
 *    (bot checks / 403s) — they fall through to the next leg when
 *    that happens, like every other leg.
 *  - SearXNG works only when SEARXNG_URL is set to a reachable
 *    instance; without it the leg is skipped, not attempted.
 *
 * Daily CSE quota: max 100 CSE calls/day, counted in a small JSON state
 * file (search-quota.json, gitignored runtime state — same pattern as
 * github-installations.json) plus an in-memory counter. The count resets
 * at midnight UTC. A failed CSE call still counts (Google bills the
 * request), so the counter is recorded BEFORE the call is made.
 *
 * Fallback triggers (any of them → next leg down; DuckDuckGo HTML is
 * plain HTTP, no JS, no Playwright — the html endpoint needs no browser
 * at all):
 *  - A key-gated leg's key/env is unset (leg skipped, not attempted);
 *  - A leg returns an error / an empty answer;
 *  - CSE keys unset, or the 100/day quota already used up;
 *  - CSE returns any 4xx/5xx, or the request fails (network/timeout).
 *  Only when ALL eleven legs fail (or return empty) does searchWeb
 *  throw — the caller answers 502 and the app falls back to opening
 *  the DuckDuckGo search URL in the browser worker.
 *
 * Safety: NO key is EVER logged and NEVER returned. Logs carry only
 * the provider, the HTTP status and the remaining quota. The CSE
 * request URL (which carries the key as a query param) is never logged;
 * the Brave key is a header, never in the URL at all.
 *
 * No new npm dependencies: Node 20 built-ins + global fetch only.
 */

const fs = require('fs');
const path = require('path');

const {
  searchBingRss,
  searchExa,
  searchFirecrawl,
  searchMarginalia,
  searchMojeek,
  searchSearxng,
  searchTavily,
  searchWikipedia,
} = require('./free-providers');

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_TIMEOUT_MS = 10000;
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

function isBraveConfigured() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY || '');
}

function isTavilyConfigured() {
  return Boolean(process.env.TAVILY_API_KEY || '');
}

function isExaConfigured() {
  return Boolean(process.env.EXA_API_KEY || '');
}

function isFirecrawlConfigured() {
  return Boolean(process.env.FIRECRAWL_API_KEY || '');
}

function isSearxngConfigured() {
  return Boolean(process.env.SEARXNG_URL || '');
}

function isCseConfigured() {
  return Boolean((process.env.GOOGLE_CSE_API_KEY || '') && (process.env.GOOGLE_CSE_CX || ''));
}

// One tracker for the process (in-memory + search-quota.json).
const defaultTracker = createQuotaTracker(QUOTA_STATE_FILE);

/** Public status for the boot log — no keys, only counts. */
function searchStatus() {
  return Object.assign(defaultTracker.status(), {
    braveConfigured: isBraveConfigured(),
    tavilyConfigured: isTavilyConfigured(),
    exaConfigured: isExaConfigured(),
    firecrawlConfigured: isFirecrawlConfigured(),
    marginaliaConfigured: true,
    searxngConfigured: isSearxngConfigured(),
    mojeekConfigured: true,
    bingConfigured: true,
    wikipediaConfigured: true,
  });
}

// ---------------------------------------------------------------------------
// Brave Search API (primary when configured)
// ---------------------------------------------------------------------------
/**
 * Pure parse of a Brave web-search response. Maps
 * data.web.results[] -> {title, url, snippet: description}, drops
 * entries without a usable url, caps at MAX_RESULTS. Exported for the
 * smoke tests. An empty web.results (or a missing web block) returns
 * [] — the caller treats that as fall-through, never as an answer.
 */
function parseBraveResponse(data) {
  const raw = data && data.web && Array.isArray(data.web.results) ? data.web.results : [];
  return raw
    .filter((it) => it && typeof it.url === 'string' && it.url)
    .slice(0, MAX_RESULTS)
    .map((it) => ({
      title: typeof it.title === 'string' ? it.title : '',
      url: it.url,
      snippet: typeof it.description === 'string' ? it.description : '',
    }));
}

async function searchWithBrave(query, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const url = BRAVE_ENDPOINT + '?q=' + encodeURIComponent(query) + '&count=10';
  const headers = {
    Accept: 'application/json',
    // The key travels as a header, never in the URL — so the URL is
    // safe to log, but we log only provider + status anyway.
    'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
  };
  // Retry ONCE after 2 s on 5xx or a network error (same pattern as
  // the DDG leg); 4xx (bad key, 429 burst) fails fast — retrying a bad
  // key or a rate limit helps nothing.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let res;
    try {
      res = await doFetch(url, {
        signal: AbortSignal.timeout(BRAVE_TIMEOUT_MS),
        headers,
      });
    } catch (err) {
      if (attempt === 1) {
        console.warn('[search] brave request failed (' + (err && err.message ? err.message : err) + '), retrying once');
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      if (res.status >= 500 && attempt === 1) {
        console.warn('[search] brave HTTP ' + res.status + ', retrying once');
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error('Brave Search HTTP ' + res.status);
    }
    const data = await res.json().catch(() => ({}));
    return parseBraveResponse(data);
  }
  throw new Error('Brave Search request failed');
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
// Search: Tavily -> Exa -> Firecrawl -> Marginalia -> SearXNG -> Mojeek
// -> Bing RSS -> Brave -> Google -> DuckDuckGo -> Wikipedia (last resort).
// Each leg runs in its own try/catch; a key-gated leg is SKIPPED (not
// attempted) when its key/env is unset; an error or an empty answer
// falls through to the next leg. First non-empty answer wins.
// ---------------------------------------------------------------------------
/**
 * @param {string} query — the search query (non-empty, already trimmed).
 * @param {object} [opts] — { tracker, fetchImpl } test overrides
 *   (tracker defaults to the process tracker backed by
 *   search-quota.json; fetchImpl is passed to EVERY leg that takes
 *   it — the Google leg always uses the global fetch).
 * @returns {Promise<{provider: "tavily"|"exa"|"firecrawl"|"marginalia"|"searxng"|"mojeek"|"bing"|"brave"|"google"|"duckduckgo"|"wikipedia", results: Array<{title,url,snippet}>, quotaRemaining: number|null}>}
 * @throws when ALL providers fail — the caller answers 502.
 */
async function searchWeb(query, opts = {}) {
  const tracker = opts.tracker || defaultTracker;

  // 1. Tavily (key-gated; skipped when TAVILY_API_KEY is unset).
  if (isTavilyConfigured()) {
    try {
      const results = await searchTavily(query, process.env.TAVILY_API_KEY, opts.fetchImpl);
      if (results.length > 0) {
        console.log('[search] tavily ok, ' + results.length + ' results');
        return { provider: 'tavily', results, quotaRemaining: null };
      }
      console.log('[search] tavily returned no results, falling back');
    } catch (err) {
      console.warn('[search] tavily failed (' + (err && err.message ? err.message : err) + '), falling back');
    }
  } else {
    console.log('[search] tavily not configured, skipping');
  }

  // 2. Exa (key-gated; skipped when EXA_API_KEY is unset).
  if (isExaConfigured()) {
    try {
      const results = await searchExa(query, process.env.EXA_API_KEY, opts.fetchImpl);
      if (results.length > 0) {
        console.log('[search] exa ok, ' + results.length + ' results');
        return { provider: 'exa', results, quotaRemaining: null };
      }
      console.log('[search] exa returned no results, falling back');
    } catch (err) {
      console.warn('[search] exa failed (' + (err && err.message ? err.message : err) + '), falling back');
    }
  } else {
    console.log('[search] exa not configured, skipping');
  }

  // 3. Firecrawl (key-gated; skipped when FIRECRAWL_API_KEY is unset).
  if (isFirecrawlConfigured()) {
    try {
      const results = await searchFirecrawl(query, process.env.FIRECRAWL_API_KEY, opts.fetchImpl);
      if (results.length > 0) {
        console.log('[search] firecrawl ok, ' + results.length + ' results');
        return { provider: 'firecrawl', results, quotaRemaining: null };
      }
      console.log('[search] firecrawl returned no results, falling back');
    } catch (err) {
      console.warn('[search] firecrawl failed (' + (err && err.message ? err.message : err) + '), falling back');
    }
  } else {
    console.log('[search] firecrawl not configured, skipping');
  }

  // 4. Marginalia (no key).
  try {
    const results = await searchMarginalia(query, opts.fetchImpl);
    if (results.length > 0) {
      console.log('[search] marginalia ok, ' + results.length + ' results');
      return { provider: 'marginalia', results, quotaRemaining: null };
    }
    console.log('[search] marginalia returned no results, falling back');
  } catch (err) {
    console.warn('[search] marginalia failed (' + (err && err.message ? err.message : err) + '), falling back');
  }

  // 5. SearXNG (skipped when SEARXNG_URL is unset).
  if (isSearxngConfigured()) {
    try {
      const results = await searchSearxng(query, process.env.SEARXNG_URL, opts.fetchImpl);
      if (results.length > 0) {
        console.log('[search] searxng ok, ' + results.length + ' results');
        return { provider: 'searxng', results, quotaRemaining: null };
      }
      console.log('[search] searxng returned no results, falling back');
    } catch (err) {
      console.warn('[search] searxng failed (' + (err && err.message ? err.message : err) + '), falling back');
    }
  } else {
    console.log('[search] searxng not configured, skipping');
  }

  // 6. Mojeek (no key; scrape leg — may be blocked from datacenter IPs).
  try {
    const results = await searchMojeek(query, opts.fetchImpl);
    if (results.length > 0) {
      console.log('[search] mojeek ok, ' + results.length + ' results');
      return { provider: 'mojeek', results, quotaRemaining: null };
    }
    console.log('[search] mojeek returned no results, falling back');
  } catch (err) {
    console.warn('[search] mojeek failed (' + (err && err.message ? err.message : err) + '), falling back');
  }

  // 7. Bing RSS (no key; scrape leg — may be blocked from datacenter IPs).
  try {
    const results = await searchBingRss(query, opts.fetchImpl);
    if (results.length > 0) {
      console.log('[search] bing ok, ' + results.length + ' results');
      return { provider: 'bing', results, quotaRemaining: null };
    }
    console.log('[search] bing returned no results, falling back');
  } catch (err) {
    console.warn('[search] bing failed (' + (err && err.message ? err.message : err) + '), falling back');
  }

  // 8. Brave (primary in the old chain; now 8th — card-gated, dormant
  // without a key). An empty Brave answer or a Brave error falls
  // through to Google — never serve an empty Brave answer while a
  // fallback exists.
  if (isBraveConfigured()) {
    try {
      const results = await searchWithBrave(query, opts.fetchImpl);
      if (results.length > 0) {
        console.log('[search] brave ok, ' + results.length + ' results');
        return { provider: 'brave', results, quotaRemaining: null };
      }
      console.log('[search] brave returned no results, falling back to google');
    } catch (err) {
      console.warn('[search] brave failed (' + (err && err.message ? err.message : err) + '), falling back to google');
    }
  } else {
    console.log('[search] brave not configured, using google/duckduckgo');
  }

  // 9. Google Custom Search (quota leg — recordUse BEFORE the call,
  // quotaRemaining from the tracker, as before).
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

  // 10. DuckDuckGo HTML fallback. An error OR an empty answer falls
  // through to Wikipedia (last resort) instead of returning empty.
  let ddgError = null;
  try {
    const results = await searchWithDuckDuckGo(query, opts.fetchImpl);
    if (results.length > 0) {
      return {
        provider: 'duckduckgo',
        results,
        quotaRemaining: configured ? tracker.remaining() : null,
      };
    }
    console.log('[search] duckduckgo returned no results, falling back to wikipedia');
    ddgError = new Error('DuckDuckGo returned no results');
  } catch (err) {
    console.warn('[search] duckduckgo failed (' + (err && err.message ? err.message : err) + '), falling back to wikipedia');
    ddgError = err;
  }

  // 11. Wikipedia (last resort). If it answers, return it; if it also
  // fails or is empty, re-throw the DuckDuckGo error so the route
  // answers 502 (all providers down).
  try {
    const results = await searchWikipedia(query, opts.fetchImpl);
    if (results.length > 0) {
      console.log('[search] wikipedia ok, ' + results.length + ' results');
      return { provider: 'wikipedia', results, quotaRemaining: null };
    }
    console.log('[search] wikipedia returned no results, all providers failed');
  } catch (err) {
    console.warn('[search] wikipedia failed (' + (err && err.message ? err.message : err) + '), all providers failed');
  }
  throw ddgError || new Error('All search providers failed');
}

module.exports = {
  CSE_DAILY_LIMIT,
  createQuotaTracker,
  isDuckDuckGoBlockPage,
  parseBraveResponse,
  parseDuckDuckGoHtml,
  searchStatus,
  searchWeb,
};
