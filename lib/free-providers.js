'use strict';
/**
 * Free no-card search providers for Nexus (fallback chain engine).
 *
 * This file is the ENGINE only: one search function + one pure parser
 * per provider, all returning [{title, url, snippet}] capped at 10.
 * Another worker wires these into lib/search.js (POST /api/search);
 * the exported names below are the CONTRACT — do not rename them.
 *
 * Chain contract (every search* function):
 *  - 10 s timeout via AbortSignal.timeout.
 *  - Retry ONCE after 2 s on 5xx or network errors; 4xx fails fast
 *    (throw immediately, no retry).
 *  - THROWS on HTTP error or when the parsed results are empty — the
 *    chain treats a throw as fall-through. Never returns [] as success.
 *  - Never logs a key or a full keyed URL (provider + status only).
 *
 * No new npm dependencies: Node 20 built-ins + global fetch only.
 * No API keys or secrets anywhere in this file — keys arrive as
 * arguments from env at call time (the caller reads env, never this
 * module). Helpers decodeHtmlEntities/stripTags are copied from
 * lib/search.js so this file stays standalone.
 *
 * VERIFICATION (2026-11-24, against each provider's own docs):
 *  - Tavily: POST https://api.tavily.com/search, Authorization: Bearer,
 *    {query, search_depth: "basic", max_results: 10}; response
 *    {results: [{title, url, content}]}. Docs: https://docs.tavily.com
 *    (verified via the docs + secondary mirrors; search_depth "basic"
 *    is the documented default, sent explicitly to hold the 1-credit
 *    tier — the only body change vs the original spec).
 *  - Exa: POST https://api.exa.ai/search, header x-api-key,
 *    {query, numResults: 10, contents: {text: {maxCharacters: 500}}};
 *    response {results: [{title, url, text, highlights, summary}]}.
 *    Docs: https://docs.exa.ai (verified). The contents block is the
 *    only body change vs the original spec: without it Exa returns
 *    title/url only and there is no snippet to map. Text/highlights
 *    are included in the base price for up to 10 results.
 *  - Firecrawl: POST https://api.firecrawl.dev/v2/search (v2 — the
 *    current docs list /v2/search; /v1/search is deprecated for
 *    search), Authorization: Bearer, {query, limit: 10}; response
 *    {success, data: {web: [{title, url, description}]}}.
 *    Docs: https://docs.firecrawl.dev/api-reference/endpoint/search
 *    (verified live 2026-11-24). Parser also accepts the legacy v1
 *    shape (data as a bare array, or data.results) defensively.
 *  - Marginalia: GET https://api2.marginalia-search.com/search?query=…
 *    &count=10, header `API-Key: public`; response
 *    {results: [{url, title, description}]}. Docs:
 *    https://github.com/MarginaliaSearch/AboutMarginaliaSearchWebsite
 *    (content/article/api.md — the official API doc; verified).
 *    The `public` key is a SHARED key: expect 429/503 rate limits.
 *  - SearXNG: GET <baseUrl>/search?q=…&format=json; response
 *    {results: [{title, url, content}]}. Verified against the
 *    SearXNG docs / deployment guides. NOTE: the JSON format is
 *    DISABLED by default in SearXNG — the instance must have
 *    search.formats including `json` in settings.yml, or every call
 *    answers 403 (which fails fast here and falls through).
 *  - Mojeek: GET https://www.mojeek.com/search?q=… with a browser
 *    User-Agent; parse HTML. Markup per the SearXNG Mojeek engine
 *    (//ul[@class="results-standard"]/li/a[@class="ob"] for the URL,
 *    ../h2/a for the title, ..//p[@class="s"] for the snippet) with a
 *    fallback for the <a class="title"> variant. UNVERIFIED LIVE:
 *    a direct fetch of mojeek.com/search returned HTTP 403 from this
 *    environment, so the live markup was NOT confirmed — the parser
 *    is tolerant of both known shapes, but treat this leg as
 *    best-effort until a live page is checked.
 *  - Bing RSS: GET https://www.bing.com/search?format=rss&q=…;
 *    standard RSS 2.0 <item><title><link><description>. UNVERIFIED
 *    LIVE: bing.com is blocked for direct fetch from this
 *    environment, so the general-search ?format=rss endpoint was NOT
 *    confirmed — the item shape is standard RSS 2.0 (confirmed for
 *    the sibling https://www.bing.com/news/search?q=…&format=rss
 *    feed) and the parser unwraps Bing's apiclick.aspx tracking
 *    redirect (url= param) when present. Treat as best-effort.
 *  - Wikipedia: GET https://en.wikipedia.org/w/api.php?action=query
 *    &list=search&srsearch=…&format=json&srlimit=10; response
 *    {query: {search: [{title, snippet}]}}. Docs: MediaWiki
 *    API:Search (verified). Snippet arrives as HTML — stripped.
 *    srlimit=10 is the documented default, sent explicitly.
 *
 * Honest limits (see also the header notes above):
 *  - Mojeek and Bing RSS are scrape legs: they can be blocked or
 *    CAPTCHA'd from datacenter IPs (Mojeek already 403'd this
 *    environment's fetcher). They sit late in the chain for that
 *    reason; a block throws and the chain moves on.
 *  - Marginalia's `public` key is shared by every consumer — a 429
 *    or 503 under load is normal, not a bug; a personal (free, by
 *    email) key would be steadier.
 *  - SearXNG depends entirely on the user's own instance being up
 *    and JSON-enabled; a down instance throws and falls through.
 *  - Wikipedia only covers topics with an article; it is a
 *    last-resort leg, not a general web search.
 */

const TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 2000;
const MAX_RESULTS = 10;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Shared helpers (decodeHtmlEntities / stripTags copied from lib/search.js)
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
  return decodeHtmlEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Strip XML CDATA wrappers, then entities. */
function stripCdata(s) {
  return decodeHtmlEntities(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when the value is a usable result URL (http/https, non-empty). */
function isUsableUrl(url) {
  return typeof url === 'string' && /^https?:\/\/\S+$/.test(url.trim());
}

/** Normalise one raw result; returns null when there is no usable url. */
function toResult(title, url, snippet) {
  if (!isUsableUrl(url)) return null;
  return {
    title: typeof title === 'string' ? stripTags(title) : '',
    url: url.trim(),
    snippet: typeof snippet === 'string' ? stripTags(snippet) : '',
  };
}

/** Cap + drop unusable entries. Shared tail for every parser. */
function finishResults(results) {
  const out = [];
  for (const r of results) {
    if (!r) continue;
    const clean = toResult(r.title, r.url, r.snippet);
    if (clean) out.push(clean);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared fetch with the chain retry policy
// ---------------------------------------------------------------------------
function isRetryableFetchError(err) {
  if (!err) return false;
  // AbortSignal.timeout() aborts with a TimeoutError; undici network
  // failures surface as TypeError ("fetch failed").
  return err.name === 'TimeoutError' || err.name === 'AbortError' || err instanceof TypeError;
}

/**
 * One fetch with the chain policy: retry ONCE after 2 s on 5xx or
 * network errors; 4xx throws immediately. Returns the Response.
 * Logs provider + status only — never the URL (it may carry a key).
 */
async function fetchWithRetry(provider, fetchImpl, url, options) {
  const doFetch = fetchImpl || fetch;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let res;
    try {
      res = await doFetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      lastError = err;
      if (attempt === 1 && isRetryableFetchError(err)) {
        console.warn('[free-search] ' + provider + ' request failed (' + (err && err.message ? err.message : err) + '), retrying once');
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new Error(provider + ' request failed: ' + (err && err.message ? err.message : err));
    }
    const status = typeof res.status === 'number' ? res.status : 200;
    const ok = typeof res.ok === 'boolean' ? res.ok : status >= 200 && status < 300;
    if (ok) return res;
    if (status >= 400 && status < 500) {
      throw new Error(provider + ' HTTP ' + status);
    }
    // 5xx (or an unknown non-2xx): retry once, then throw.
    lastError = new Error(provider + ' HTTP ' + status);
    if (attempt === 1) {
      console.warn('[free-search] ' + provider + ' HTTP ' + status + ', retrying once');
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    throw lastError;
  }
  throw lastError || new Error(provider + ' request failed');
}

async function readJson(provider, res) {
  try {
    return await res.json();
  } catch (_) {
    throw new Error(provider + ' returned invalid JSON');
  }
}

async function readText(provider, res) {
  try {
    return await res.text();
  } catch (err) {
    throw new Error(provider + ' response unreadable: ' + (err && err.message ? err.message : err));
  }
}

/**
 * Shared tail for every search* function: parse, log provider + count,
 * throw when empty (the chain treats a throw as fall-through).
 */
function finishSearch(provider, results) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(provider + ' returned no results');
  }
  console.log('[free-search] ' + provider + ' ok, ' + results.length + ' results');
  return results;
}

// ---------------------------------------------------------------------------
// Tavily — POST https://api.tavily.com/search
// ---------------------------------------------------------------------------
function parseTavilyResponse(data) {
  const items = data && Array.isArray(data.results) ? data.results : [];
  return finishResults(
    items.map((it) => ({
      title: it && it.title,
      url: it && it.url,
      snippet: it && (it.content || it.snippet || ''),
    }))
  );
}

async function searchTavily(query, apiKey, fetchImpl) {
  const res = await fetchWithRetry('tavily', fetchImpl, 'https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, search_depth: 'basic', max_results: MAX_RESULTS }),
  });
  return finishSearch('tavily', parseTavilyResponse(await readJson('tavily', res)));
}

// ---------------------------------------------------------------------------
// Exa — POST https://api.exa.ai/search
// ---------------------------------------------------------------------------
function parseExaResponse(data) {
  const items = data && Array.isArray(data.results) ? data.results : [];
  return finishResults(
    items.map((it) => {
      let snippet = '';
      if (it) {
        if (typeof it.text === 'string' && it.text) snippet = it.text;
        else if (Array.isArray(it.highlights) && it.highlights.length) snippet = it.highlights.join(' ');
        else if (typeof it.summary === 'string') snippet = it.summary;
      }
      return { title: it && it.title, url: it && it.url, snippet };
    })
  );
}

async function searchExa(query, apiKey, fetchImpl) {
  const res = await fetchWithRetry('exa', fetchImpl, 'https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    // contents.text: without it Exa returns title/url only and there is
    // no snippet to map; text is in the base price up to 10 results.
    body: JSON.stringify({
      query,
      numResults: MAX_RESULTS,
      contents: { text: { maxCharacters: 500 } },
    }),
  });
  return finishSearch('exa', parseExaResponse(await readJson('exa', res)));
}

// ---------------------------------------------------------------------------
// Firecrawl — POST https://api.firecrawl.dev/v2/search
// ---------------------------------------------------------------------------
function parseFirecrawlResponse(data) {
  // Current v2 shape: {success, data: {web: [{title, url, description}]}}.
  // Defensive fallbacks: legacy v1 shape (data as a bare array, or
  // data.results) and a top-level results array.
  let items = [];
  if (data && data.data && Array.isArray(data.data.web)) items = data.data.web;
  else if (data && data.data && Array.isArray(data.data.results)) items = data.data.results;
  else if (data && Array.isArray(data.data)) items = data.data;
  else if (data && Array.isArray(data.results)) items = data.results;
  // News results (data.news) share title/url/snippet fields; include
  // them after web results if web came back short.
  const news = data && data.data && Array.isArray(data.data.news) ? data.data.news : [];
  const combined = items.concat(news);
  return finishResults(
    combined.map((it) => ({
      title: it && it.title,
      url: it && it.url,
      snippet: it && (it.description || it.snippet || it.markdown || ''),
    }))
  );
}

async function searchFirecrawl(query, apiKey, fetchImpl) {
  const res = await fetchWithRetry('firecrawl', fetchImpl, 'https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: MAX_RESULTS }),
  });
  return finishSearch('firecrawl', parseFirecrawlResponse(await readJson('firecrawl', res)));
}

// ---------------------------------------------------------------------------
// Marginalia — GET https://api2.marginalia-search.com/search
// ---------------------------------------------------------------------------
function parseMarginaliaResponse(data) {
  const items = data && Array.isArray(data.results) ? data.results : [];
  return finishResults(
    items.map((it) => ({
      title: it && it.title,
      url: it && it.url,
      snippet: it && (it.description || it.snippet || ''),
    }))
  );
}

async function searchMarginalia(query, fetchImpl) {
  const url =
    'https://api2.marginalia-search.com/search?query=' +
    encodeURIComponent(query) +
    '&count=' +
    MAX_RESULTS;
  const res = await fetchWithRetry('marginalia', fetchImpl, url, {
    headers: { 'API-Key': 'public' },
  });
  return finishSearch('marginalia', parseMarginaliaResponse(await readJson('marginalia', res)));
}

// ---------------------------------------------------------------------------
// SearXNG — GET <baseUrl>/search?q=…&format=json
// ---------------------------------------------------------------------------
function parseSearxngResponse(data) {
  const items = data && Array.isArray(data.results) ? data.results : [];
  return finishResults(
    items.map((it) => ({
      title: it && it.title,
      url: it && it.url,
      snippet: it && (it.content || it.snippet || ''),
    }))
  );
}

async function searchSearxng(query, baseUrl, fetchImpl) {
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  if (!/^https?:\/\//.test(base)) {
    throw new Error('searxng base URL is not configured (SEARXNG_URL must be an http(s) URL)');
  }
  const url = base + '/search?q=' + encodeURIComponent(query) + '&format=json';
  const res = await fetchWithRetry('searxng', fetchImpl, url, {
    headers: { Accept: 'application/json' },
  });
  return finishSearch('searxng', parseSearxngResponse(await readJson('searxng', res)));
}

// ---------------------------------------------------------------------------
// Mojeek — GET https://www.mojeek.com/search?q=… (HTML scrape)
// UNVERIFIED LIVE: mojeek.com/search answered HTTP 403 to this
// environment's fetcher, so the markup below was NOT confirmed live.
// It follows the SearXNG Mojeek engine xpaths
// (//ul[@class="results-standard"]/li/a[@class="ob"],
//  ../h2/a title, ..//p[@class="s"] snippet) with a fallback for the
// <a class="title"> variant. Mojeek's robots.txt disallows /search
// and it sells a keyed API — this leg is a best-effort fallback.
// ---------------------------------------------------------------------------
function parseMojeekHtml(html) {
  const text = typeof html === 'string' ? html : '';
  const results = [];
  // One block per <li>…</li>; the results list is ul.results-standard
  // when present, but fall back to any <li> so a markup change degrades
  // instead of silently returning nothing.
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let block;
  while ((block = liRe.exec(text)) !== null && results.length < MAX_RESULTS) {
    const body = block[1];
    // URL: the outbound link a.ob first, then a.title, then the h2 link.
    let url = '';
    let m =
      body.match(/<a[^>]*class="[^"]*\bob\b[^"]*"[^>]*href="([^"]+)"/i) ||
      body.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*\bob\b[^"]*"/i) ||
      body.match(/<a[^>]*class="[^"]*\btitle\b[^"]*"[^>]*href="([^"]+)"/i) ||
      body.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*\btitle\b[^"]*"/i) ||
      body.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/i);
    if (m) url = decodeHtmlEntities(m[1]).trim();
    if (!url) continue;
    // Relative links (e.g. /search?... or //host/…) resolve against Mojeek.
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = 'https://www.mojeek.com' + url;
    // Skip Mojeek's own navigation/search links, not results.
    if (/^https?:\/\/(www\.)?mojeek\.com\/search/i.test(url)) continue;
    if (!isUsableUrl(url)) continue;
    // Title: h2 > a text first, then a.title text.
    let title = '';
    m = body.match(/<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i) || body.match(/<a[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (m) title = m[1];
    // Snippet: <p class="s">…</p>.
    let snippet = '';
    m = body.match(/<p[^>]*class="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (m) snippet = m[1];
    const clean = toResult(title, url, snippet);
    if (clean) results.push(clean);
  }
  return finishResults(results);
}

async function searchMojeek(query, fetchImpl) {
  const url = 'https://www.mojeek.com/search?q=' + encodeURIComponent(query);
  const res = await fetchWithRetry('mojeek', fetchImpl, url, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  return finishSearch('mojeek', parseMojeekHtml(await readText('mojeek', res)));
}

// ---------------------------------------------------------------------------
// Bing RSS — GET https://www.bing.com/search?format=rss&q=… (RSS 2.0)
// UNVERIFIED LIVE: bing.com is blocked for direct fetch from this
// environment, so the general-search ?format=rss endpoint was NOT
// confirmed live. The parser follows standard RSS 2.0 item shape
// (confirmed for the sibling news feed
// https://www.bing.com/news/search?q=…&format=rss) and unwraps Bing's
// apiclick.aspx tracking redirect when present. A 200 bot-check page
// has no <item> tags, so it throws (empty) and the chain moves on.
// ---------------------------------------------------------------------------
function parseBingRss(xml) {
  const text = typeof xml === 'string' ? xml : '';
  const results = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let item;
  while ((item = itemRe.exec(text)) !== null && results.length < MAX_RESULTS) {
    const body = item[1];
    const pick = (tag) => {
      const m = body.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
      return m ? stripCdata(m[1]) : '';
    };
    let url = pick('link');
    // Bing wraps result links in a tracking redirect:
    // https://www.bing.com/news/apiclick.aspx?…&url=<encoded real URL>
    // (observed on the news RSS feed). Decode the real destination.
    const apiclick = url.match(/[?&]url=([^&]+)/i);
    if (apiclick) {
      try {
        url = decodeURIComponent(apiclick[1]);
      } catch (_) {
        // Keep the raw link; finishResults drops it if unusable.
      }
    }
    url = decodeHtmlEntities(url).trim();
    const clean = toResult(pick('title'), url, pick('description'));
    if (clean) results.push(clean);
  }
  return finishResults(results);
}

async function searchBingRss(query, fetchImpl) {
  const url = 'https://www.bing.com/search?format=rss&q=' + encodeURIComponent(query);
  const res = await fetchWithRetry('bing-rss', fetchImpl, url, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'application/rss+xml,application/xml,text/xml',
    },
  });
  return finishSearch('bing-rss', parseBingRss(await readText('bing-rss', res)));
}

// ---------------------------------------------------------------------------
// Wikipedia — GET https://en.wikipedia.org/w/api.php (Action API)
// ---------------------------------------------------------------------------
function parseWikipediaResponse(data) {
  const items = data && data.query && Array.isArray(data.query.search) ? data.query.search : [];
  return finishResults(
    items.map((it) => {
      const title = it && typeof it.title === 'string' ? it.title : '';
      return {
        title,
        url: title ? 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')) : '',
        snippet: it && it.snippet ? stripTags(it.snippet) : '',
      };
    })
  );
}

async function searchWikipedia(query, fetchImpl) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
    encodeURIComponent(query) +
    '&format=json&srlimit=' +
    MAX_RESULTS;
  const res = await fetchWithRetry('wikipedia', fetchImpl, url, {
    headers: { 'User-Agent': 'NexusSearch/1.0 (https://github.com/faridahmed6682-bussiness/nexus-browser-server)', Accept: 'application/json' },
  });
  return finishSearch('wikipedia', parseWikipediaResponse(await readJson('wikipedia', res)));
}

module.exports = {
  parseBingRss,
  parseExaResponse,
  parseFirecrawlResponse,
  parseMarginaliaResponse,
  parseMojeekHtml,
  parseSearxngResponse,
  parseTavilyResponse,
  parseWikipediaResponse,
  searchBingRss,
  searchExa,
  searchFirecrawl,
  searchMarginalia,
  searchMojeek,
  searchSearxng,
  searchTavily,
  searchWikipedia,
};
