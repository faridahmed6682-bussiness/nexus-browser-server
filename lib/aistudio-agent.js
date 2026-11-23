'use strict';
/**
 * lib/aistudio-agent.js — server-side AI Studio build driver for the
 * Nexus browser worker.
 *
 * The engine drives Google AI Studio in a pooled Playwright browser
 * context: open AI Studio, paste the user's build prompt, click Build,
 * and poll until a preview/app URL appears.
 *
 * DESIGN RULES (do not break these):
 *  - LLM spec (decided by the user 2026-11-23 21:20): provider is
 *    Google AI Studio (Gemini), primary model gemini-3.6-flash, key
 *    from the DEDICATED server env slot BROWSER_AGENT_GEMINI_KEY.
 *    Failover, own slots only, in order: gemini-3.6-flash (same key)
 *    -> gemini-3.1-flash-lite (same key) -> OpenRouter
 *    qwen/qwen3-coder:free (own slot BROWSER_AGENT_OPENROUTER_KEY).
 *    NEVER Groq, NEVER any chat agent's key. Keys come from env vars
 *    ONLY and are read fresh on every decision (no caching).
 *  - The LLM ONLY picks the next action from a fixed vocabulary
 *    (observe | fill_prompt | click_build | done | fail). It never runs
 *    code and never chooses selectors — all selectors/heuristic picks
 *    live in this file (the engine).
 *  - No new npm dependencies: Node 20 built-ins + global fetch +
 *    the Playwright page object supplied via helpers.
 *  - The API key is NEVER logged and NEVER included in results,
 *    steps, params, or error strings.
 *  - Session cookies are never logged (only counts, never values).
 *  - job._cancelled is checked between every step; on cancel the run
 *    aborts promptly with status 'cancelled'.
 *
 * Wiring contract (server.js passes `helpers` in):
 *   helpers = { getPool, applyCookies, harvestCookies, applyStealth,
 *               takeSmallScreenshot, isChallengePage }
 *   runAiStudioBuild(job, update, helpers) -> {
 *     ok, status, appUrl, previewUrl, error, cookies, screenshotBase64 }
 *   status: 'built' | 'failed' | 'login-required' | 'cancelled'
 *           | 'timeout' | 'not-configured'
 *   screenshotBase64 is included on built/failed outcomes only
 *   (null otherwise).
 */

const OP_TIMEOUT_MS = 15000; // per-Playwright-op timeout
const LLM_TIMEOUT_MS = 20000; // per-LLM-call timeout
const POLL_INTERVAL_MS = 15000; // post-build observe poll interval
const FAILURE_RETRY_WAIT_MS = 20000; // wait before the one build retry
const MAX_OBSERVE_RETRIES = 3; // consecutive 'observe' actions, then fail
const MAX_FAILURE_RETRIES = 1; // one retry after build-failure text

const DEFAULT_URL = 'https://aistudio.google.com/';
const DEFAULT_MAX_MINUTES = 10;
const MAX_MAX_MINUTES = 60;

// Failover chain (fixed order — see header). Gemini legs share the one
// dedicated Gemini key; the OpenRouter leg has its own dedicated key.
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const CHAIN = ['gemini-3.6-flash', 'gemini-3.1-flash-lite', 'openrouter/qwen/qwen3-coder:free'];
const DEFAULT_RPM_BUDGET = 30; // per model, per 60s window
const RPM_WINDOW_MS = 60 * 1000;
const COOLDOWN_DEFAULT_MS = 60 * 1000; // 429/503 with no Retry-After
const COOLDOWN_BAD_REQUEST_MS = 5 * 60 * 1000; // other 4xx: bad key etc.

// User-facing errors are BN+EN.
const ERR_NOT_CONFIGURED =
  'বিল্ড এজেন্টের API কী সেট করা হয়নি — সার্ভারে BROWSER_AGENT_GEMINI_KEY দিন · Build agent API key is not configured — set BROWSER_AGENT_GEMINI_KEY on the server';
const ERR_ALL_COOLING =
  'সব এজেন্ট মডেল এখন ঠান্ডা হচ্ছে — একটু পরে আবার চেষ্টা করুন · All agent models are cooling down — try again shortly';
const ERR_NO_PROMPT =
  'বিল্ড করার নির্দেশনা দেওয়া হয়নি · No build prompt was provided';
const ERR_INVALID_URL =
  'সঠিক URL দিন — http:// বা https:// দিয়ে শুরু হতে হবে · Invalid URL — must start with http:// or https://';
const ERR_LOGIN_REQUIRED =
  'Google-এ লগইন দরকার — ফোনে Google লগইন করে আবার চেষ্টা করুন · Google login required — sign in to Google on the phone and try again';
const ERR_CHALLENGE =
  'ক্যাপচা/যাচাই ধরা পড়েছে — মানুষের যাচাই দরকার · Captcha/challenge detected — needs a human';
const ERR_CANCELLED =
  'কাজ বন্ধ করে দেওয়া হয়েছে · Work was cancelled';
const ERR_TIMEOUT =
  'সময় শেষ — নির্ধারিত সময়ের মধ্যে বিল্ড শেষ হয়নি · Timed out — the build did not finish in time';
const ERR_BUILD_BUTTON =
  'Build বোতাম পাওয়া যায়নি — AI Studio পাতাটি বদলে থাকতে পারে · Build button not found — the AI Studio page may have changed';
const ERR_PROMPT_BOX =
  'প্রম্পট লেখার জায়গা পাওয়া যায়নি — AI Studio পাতাটি বদলে থাকতে পারে · Prompt box not found — the AI Studio page may have changed';
const ERR_OBSERVE_LOOP =
  'এজেন্ট পরপর কয়েকবার শুধু দেখল, এগোতে পারল না · The agent kept observing without making progress';
const ERR_DONE_NO_URL =
  'বিল্ড শেষ বলে জানালেও অ্যাপের লিংক পাওয়া যায়নি · The agent reported done but no app URL was found';
const ERR_BUILD_FAILED =
  'বিল্ড ব্যর্থ হয়েছে · The build failed';
const ERR_POOL =
  'ব্রাউজার পাওয়া যায়নি — আবার চেষ্টা করুন · Browser unavailable — try again';

/** Dedicated key slots, read fresh from env on every call (never cached). */
function agentKeys() {
  return {
    gemini: (process.env.BROWSER_AGENT_GEMINI_KEY || '').trim(),
    openrouter: (process.env.BROWSER_AGENT_OPENROUTER_KEY || '').trim(),
  };
}

function rpmBudget() {
  const n = Number.parseInt(process.env.BROWSER_AGENT_RPM_BUDGET || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RPM_BUDGET;
}

/** True when the primary (Gemini) dedicated key is present. */
function isAgentLlmConfigured() {
  return agentKeys().gemini.length > 0;
}

/** True when at least one failover leg has a key. */
function anyLegConfigured() {
  const k = agentKeys();
  return k.gemini.length > 0 || k.openrouter.length > 0;
}

/** Status for the server boot log — never includes any key. */
function agentLlmStatus() {
  const k = agentKeys();
  return {
    configured: k.gemini.length > 0,
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    chain: CHAIN.slice(),
    openrouterConfigured: k.openrouter.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Failover health (in-memory, same rules as the app's ApiKeyFailoverManager)
// ---------------------------------------------------------------------------
// Per-model: { status: 'healthy'|'cooling', cooldownUntil, window: [ts] }.
// window holds request timestamps inside the current 60s window.
const modelHealth = new Map();

function healthFor(id) {
  let h = modelHealth.get(id);
  if (!h) {
    h = { status: 'healthy', cooldownUntil: 0, window: [] };
    modelHealth.set(id, h);
  }
  return h;
}

function pruneWindow(h, now) {
  h.window = h.window.filter((ts) => now - ts < RPM_WINDOW_MS);
}

function markCooling(id, delayMs) {
  const h = healthFor(id);
  h.status = 'cooling';
  h.cooldownUntil = Date.now() + delayMs;
}

/** Parse a Retry-After header (seconds, or an HTTP date) -> delay ms. */
function retryAfterDelayMs(res) {
  const raw = res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('retry-after')
    : null;
  if (raw == null || raw === '') return COOLDOWN_DEFAULT_MS;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return COOLDOWN_DEFAULT_MS;
}

/** The failover chain as callable legs, skipping legs with no key. */
function buildLegs() {
  const k = agentKeys();
  const legs = [];
  if (k.gemini) {
    legs.push({ id: 'gemini-3.6-flash', kind: 'gemini', model: 'gemini-3.6-flash', key: k.gemini });
    legs.push({ id: 'gemini-3.1-flash-lite', kind: 'gemini', model: 'gemini-3.1-flash-lite', key: k.gemini });
  }
  if (k.openrouter) {
    legs.push({ id: 'openrouter/qwen/qwen3-coder:free', kind: 'openrouter', model: 'qwen/qwen3-coder:free', key: k.openrouter });
  }
  return legs;
}

/**
 * Pick the first leg in chain order that is healthy AND under its RPM
 * budget in the current 60s window. A leg at budget is skipped WITHOUT
 * being called (rotate before hitting the limit). Returns null when no
 * leg is currently usable.
 */
function pickLeg(legs, tried) {
  const now = Date.now();
  const budget = rpmBudget();
  for (const leg of legs) {
    if (tried.has(leg.id)) continue;
    const h = healthFor(leg.id);
    if (h.status === 'cooling') {
      if (now < h.cooldownUntil) continue;
      h.status = 'healthy';
      h.cooldownUntil = 0;
    }
    pruneWindow(h, now);
    if (h.window.length >= budget) continue; // at budget: rotate, don't call
    return leg;
  }
  return null;
}

function truncate(str, n) {
  const s = typeof str === 'string' ? str : '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCancelled(job) {
  return Boolean(job && job._cancelled);
}

class FlowStop extends Error {
  constructor(status, message) {
    super(message || status);
    this.status = status;
  }
}

function cancelledStop() {
  return new FlowStop('cancelled', ERR_CANCELLED);
}

function timeoutStop() {
  return new FlowStop('timeout', ERR_TIMEOUT);
}

/** Sleep in small chunks so cancel / deadline abort promptly. */
async function sleepCancellable(job, deadline, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (isCancelled(job)) throw cancelledStop();
    if (Date.now() >= deadline) throw timeoutStop();
    const remaining = end - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(500, remaining));
  }
}

function checkCancelled(job) {
  if (isCancelled(job)) throw cancelledStop();
}

function checkDeadline(job, deadline) {
  if (isCancelled(job)) throw cancelledStop();
  if (Date.now() >= deadline) throw timeoutStop();
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/** Collect the visible page state the LLM decides from. */
async function observe(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textOf = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const buttons = [];
    for (const b of document.querySelectorAll('button')) {
      if (buttons.length >= 30) break;
      if (!isVisible(b)) continue;
      buttons.push({ text: textOf(b), 'aria-label': b.getAttribute('aria-label') || '' });
    }
    const inputs = [];
    for (const el of document.querySelectorAll('textarea, input, [contenteditable="true"]')) {
      if (inputs.length >= 10) break;
      if (!isVisible(el)) continue;
      inputs.push({
        placeholder: el.getAttribute('placeholder') || '',
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        'aria-label': el.getAttribute('aria-label') || '',
      });
    }
    const appLinks = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (appLinks.length >= 5) break;
      const href = a.getAttribute('href') || '';
      if (/preview|aistudio\.google\.com\/app\//i.test(href)) appLinks.push(href);
    }
    return {
      url: window.location.href,
      title: document.title || '',
      visibleText: (document.body ? (document.body.innerText || '') : '').slice(0, 3000),
      buttons,
      inputs,
      appLinks,
    };
  }, { timeout: OP_TIMEOUT_MS });
}

const READY_TEXT_RE = /your app is ready|build complete|preview ready/i;
const FAILURE_TEXT_RE = /build failed|something went wrong|error occurred/i;
const SIGN_IN_TEXT_RE = /sign in to continue/i;
const BUILD_BUTTON_RE = /^(build|create|generate|deploy)/i;

/** Completion signal from an observed state: { appUrl, previewUrl } or null. */
function completionFromState(state) {
  if (!state) return null;
  const url = state.url || '';
  let appUrl = null;
  let previewUrl = null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'aistudio.google.com' && url.includes('/app/')) appUrl = url;
  } catch (_) { /* ignore malformed url */ }
  for (const href of state.appLinks || []) {
    const absolute = href.startsWith('http') ? href : 'https://aistudio.google.com' + href;
    if (!appUrl && /aistudio\.google\.com\/app\//i.test(absolute)) appUrl = absolute;
    if (!previewUrl && /preview/i.test(absolute)) previewUrl = absolute;
  }
  if (!previewUrl) previewUrl = appUrl;
  const textReady = READY_TEXT_RE.test(state.visibleText || '');
  if (appUrl || textReady) return { appUrl, previewUrl };
  return null;
}

function hasPromptBox(state) {
  return Array.isArray(state.inputs) && state.inputs.length > 0;
}

function isLoginRequiredState(page, state) {
  let host = '';
  try {
    host = new URL(page.url()).hostname;
  } catch (_) { /* ignore */ }
  if (host === 'accounts.google.com') return true;
  return SIGN_IN_TEXT_RE.test(state.visibleText || '') && !hasPromptBox(state);
}

// ---------------------------------------------------------------------------
// LLM decision — fixed action vocabulary only, never code, never selectors.
// ---------------------------------------------------------------------------

const LLM_SYSTEM_PROMPT =
  'You drive Google AI Studio in a browser. Reply with JSON only: ' +
  '{"action":"observe"|"fill_prompt"|"click_build"|"done"|"fail","reason":"...","appUrl":"..."}';

/**
 * One HTTP call to one leg. Returns { text } on HTTP success, or
 * { error: 'rate-limited' | 'bad-request' | 'transient' } on failure.
 * - 429/503: cool the model for Retry-After (default 60s).
 * - Other 4xx: cool the model for 5 minutes (a bad key must not wedge
 *   the agent). Other 5xx: cool for 60s.
 * - Network error / abort: transient, no cooling — the next leg is tried.
 * The key is sent in a header only, never in a URL, and never logged.
 */
async function callLeg(leg, systemPrompt, userContent) {
  let url;
  let headers;
  let body;
  if (leg.kind === 'gemini') {
    url = GEMINI_API_BASE + '/models/' + encodeURIComponent(leg.model) + ':generateContent';
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': leg.key };
    body = {
      contents: [{ parts: [{ text: systemPrompt + '\n\n' + userContent }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
    };
  } else {
    url = OPENROUTER_API_BASE + '/chat/completions';
    headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + leg.key };
    body = {
      model: leg.model,
      temperature: 0.2,
      max_tokens: 800,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    };
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (_) {
    return { error: 'transient' };
  }
  if (!res.ok) {
    if (res.status === 429 || res.status === 503) {
      markCooling(leg.id, retryAfterDelayMs(res));
      return { error: 'rate-limited' };
    }
    if (res.status >= 400 && res.status < 500) {
      markCooling(leg.id, COOLDOWN_BAD_REQUEST_MS);
      return { error: 'bad-request' };
    }
    markCooling(leg.id, COOLDOWN_DEFAULT_MS);
    return { error: 'transient' };
  }
  // HTTP success: record the request in this model's RPM window.
  healthFor(leg.id).window.push(Date.now());
  let data;
  try {
    data = await res.json();
  } catch (_) {
    return { text: '' };
  }
  if (leg.kind === 'gemini') {
    const parts = data && data.candidates && data.candidates[0]
      && data.candidates[0].content && data.candidates[0].content.parts;
    const text = Array.isArray(parts)
      ? parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
      : '';
    return { text };
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '')
    : '';
  return { text: content };
}

/** Extract the JSON action object from a reply (tolerates prose/fences). */
function parseActionReply(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

/**
 * Ask the LLM for the next action, walking the failover chain in order.
 * Returns { action, reason, appUrl } like before, or
 * { action: 'unavailable' } when every leg is cooling/unavailable —
 * the caller turns that into a clear 'failed' result, never a spin.
 * An unparsable reply (or a leg that errors without cooling state)
 * falls back to 'observe', bounded by the caller's observe counter.
 */
async function decideNextAction(job, state, buildClicked) {
  const userContent = JSON.stringify({
    observed: state,
    goal: truncate(job.params.prompt || '', 500),
    buildClicked: Boolean(buildClicked),
  });
  const legs = buildLegs();
  const tried = new Set();
  for (;;) {
    const leg = pickLeg(legs, tried);
    if (!leg) return { action: 'unavailable', reason: 'all legs cooling or unavailable' };
    tried.add(leg.id);
    const result = await callLeg(leg, LLM_SYSTEM_PROMPT, userContent);
    if (result.error) continue; // cooled (or transient) — try the next leg
    const parsed = parseActionReply(result.text || '');
    if (!parsed) return { action: 'observe', reason: 'llm unparsable' };
    const action = typeof parsed.action === 'string' ? parsed.action : 'observe';
    const allowed = new Set(['observe', 'fill_prompt', 'click_build', 'done', 'fail']);
    return {
      action: allowed.has(action) ? action : 'observe',
      reason: typeof parsed.reason === 'string' ? truncate(parsed.reason, 200) : '',
      appUrl: typeof parsed.appUrl === 'string' ? parsed.appUrl : '',
    };
  }
}

// ---------------------------------------------------------------------------
// Engine actions — heuristics live here, never in the LLM.
// ---------------------------------------------------------------------------

/**
 * Find the prompt box: a textarea/contenteditable whose
 * placeholder/aria-label matches /describe|prompt|build|app/i, else the
 * largest visible textarea, else the first visible textarea.
 * Returns { kind: 'textarea'|'contenteditable', index } or null.
 */
async function findPromptBox(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const cands = [];
    const els = document.querySelectorAll('textarea, [contenteditable="true"]');
    els.forEach((el, i) => {
      if (!isVisible(el)) return;
      const r = el.getBoundingClientRect();
      const hay = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      cands.push({
        index: i,
        kind: el.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'contenteditable',
        area: r.width * r.height,
        hinted: /describe|prompt|build|app/i.test(hay),
      });
    });
    if (cands.length === 0) return null;
    const hinted = cands.find((c) => c.hinted);
    if (hinted) return { kind: hinted.kind, index: hinted.index };
    const largest = cands.slice().sort((a, b) => b.area - a.area)[0];
    return { kind: largest.kind, index: largest.index };
  }, { timeout: OP_TIMEOUT_MS });
}

async function fillPrompt(page, prompt) {
  const box = await findPromptBox(page);
  if (!box) throw new FlowStop('failed', ERR_PROMPT_BOX);
  const locator = page.locator('textarea, [contenteditable="true"]').nth(box.index);
  if (box.kind === 'textarea') {
    await locator.fill(prompt, { timeout: OP_TIMEOUT_MS });
  } else {
    await locator.click({ timeout: OP_TIMEOUT_MS });
    await page.evaluate(
      ({ index, text }) => {
        const el = document.querySelectorAll('[contenteditable="true"]')[index];
        if (!el) return;
        el.focus();
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      },
      { index: box.index, text: prompt },
    ).catch(() => {});
  }
}

/** Click the Build button: text/aria-label starting with build/create/generate/deploy, else a button containing 'build'. */
async function clickBuild(page) {
  const idx = await page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const btns = Array.from(document.querySelectorAll('button')).filter(isVisible);
    const label = (b) => (((b.textContent || '').trim() + ' ' + (b.getAttribute('aria-label') || '')).trim());
    const exact = btns.findIndex((b) => /^(build|create|generate|deploy)/i.test(label(b)));
    if (exact >= 0) return exact;
    const loose = btns.findIndex((b) => /build/i.test(label(b)));
    return loose;
  }, { timeout: OP_TIMEOUT_MS });
  if (idx === null || idx === undefined || idx < 0) {
    throw new FlowStop('failed', ERR_BUILD_BUTTON);
  }
  await page.locator('button').nth(idx).click({ timeout: OP_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function runAiStudioBuild(job, update, helpers) {
  const safeUpdate = (text, progress) => {
    try {
      if (typeof update === 'function') update(text, progress);
    } catch (_) { /* step logging must never break the run */ }
  };
  const params = (job && job.params) || {};
  const prompt = typeof params.prompt === 'string' ? params.prompt : '';
  const url = typeof params.url === 'string' && params.url ? params.url : DEFAULT_URL;
  const maxMinutesRaw = Number(params.maxMinutes);
  const maxMinutes = Number.isFinite(maxMinutesRaw) && maxMinutesRaw > 0
    ? Math.min(maxMinutesRaw, MAX_MAX_MINUTES)
    : DEFAULT_MAX_MINUTES;
  const deadline = Date.now() + maxMinutes * 60 * 1000;

  // Terminal-result builder: harvests cookies on every terminal return
  // and attaches a small screenshot on built/failed outcomes only.
  // `ctx` is an object { context, page } filled in as the run proceeds.
  const finish = async (status, opts) => {
    const o = opts || {};
    let cookies = [];
    try {
      if (ctx.context && helpers && typeof helpers.harvestCookies === 'function') {
        cookies = await helpers.harvestCookies(ctx.context).catch(() => []);
      }
    } catch (_) {
      cookies = [];
    }
    let screenshotBase64 = null;
    if ((status === 'built' || status === 'failed') && ctx.page && helpers && typeof helpers.takeSmallScreenshot === 'function') {
      try {
        const shot = await helpers.takeSmallScreenshot(ctx.page, {});
        screenshotBase64 = shot && shot.jpegBase64 ? shot.jpegBase64 : null;
      } catch (_) {
        screenshotBase64 = null;
      }
    }
    return {
      ok: status === 'built',
      status,
      appUrl: o.appUrl || null,
      previewUrl: o.previewUrl || null,
      error: o.error || null,
      cookies: Array.isArray(cookies) ? cookies : [],
      screenshotBase64,
    };
  };

  const ctx = { context: null, page: null };

  // 0. Dedicated-LLM config gate — no browser is launched when no leg
  // has a key. (isAgentLlmConfigured() is the stricter boot-log check:
  // Gemini key present. The run gate is any-leg, so an OpenRouter-only
  // setup can still run via leg 3.)
  if (!anyLegConfigured()) {
    return finish('not-configured', { error: ERR_NOT_CONFIGURED });
  }
  if (!prompt.trim()) {
    return finish('failed', { error: ERR_NO_PROMPT });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (_) {
    return finish('failed', { error: ERR_INVALID_URL });
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return finish('failed', { error: ERR_INVALID_URL });
  }
  if (!helpers || typeof helpers.getPool !== 'function' || typeof helpers.applyCookies !== 'function'
    || typeof helpers.applyStealth !== 'function' || typeof helpers.isChallengePage !== 'function') {
    return finish('failed', { error: ERR_POOL });
  }
  checkCancelled(job);

  let pool;
  try {
    pool = await helpers.getPool();
  } catch (err) {
    return finish('failed', { error: ERR_POOL });
  }

  try {
    // (1) Acquire a pooled context; always released in `finally`.
    safeUpdate('ব্রাউজার নেওয়া হচ্ছে · Acquiring browser…', 5);
    try {
      ctx.context = await pool.acquire();
    } catch (err) {
      return finish('failed', { error: ERR_POOL });
    }
    checkCancelled(job);
    checkDeadline(job, deadline);

    // (2) Apply per-request Google session cookies, open a page, stealth.
    safeUpdate('সেশন লাগানো হচ্ছে · Applying session…', 10);
    await helpers.applyCookies(ctx.context, params.cookies);
    checkCancelled(job);
    ctx.page = await ctx.context.newPage();
    await helpers.applyStealth(ctx.page);
    checkCancelled(job);

    // (3) Open AI Studio.
    safeUpdate('AI Studio খোলা হচ্ছে · Opening AI Studio…', 15);
    await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: OP_TIMEOUT_MS });
    await ctx.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    checkCancelled(job);
    checkDeadline(job, deadline);

    // (4) Challenge / CAPTCHA check.
    if (await helpers.isChallengePage(ctx.page)) {
      return finish('failed', { error: ERR_CHALLENGE });
    }
    checkCancelled(job);

    // (5) Login-required check (also re-checked on every observe below).
    let state = await observe(ctx.page);
    if (isLoginRequiredState(ctx.page, state)) {
      return finish('login-required', { error: ERR_LOGIN_REQUIRED });
    }
    safeUpdate('পাতা দেখা হচ্ছে · Observing page…', 25);
    checkCancelled(job);
    checkDeadline(job, deadline);

    // (7)-(9) Pre-build loop: observe -> LLM decides -> fill / click.
    // Once Build is clicked, phase B takes over: pure 15s polling.
    let consecutiveObserves = 0;
    let buildClicked = false;
    let promptFilled = false;

    for (;;) {
      checkCancelled(job);
      checkDeadline(job, deadline);

      // Completion may already be visible (e.g. resumed build).
      const done = completionFromState(state);
      if (done) {
        safeUpdate('অ্যাপ তৈরি · App ready', 100);
        return finish('built', { appUrl: done.appUrl, previewUrl: done.previewUrl });
      }
      if (isLoginRequiredState(ctx.page, state)) {
        return finish('login-required', { error: ERR_LOGIN_REQUIRED });
      }
      if (await helpers.isChallengePage(ctx.page)) {
        return finish('failed', { error: ERR_CHALLENGE });
      }

      // (7) Ask the dedicated LLM for the next action only.
      safeUpdate('পরের ধাপ ঠিক করা হচ্ছে · Deciding next step…', 35);
      const decision = await decideNextAction(job, state, buildClicked);
      checkCancelled(job);
      checkDeadline(job, deadline);

      if (decision.action === 'unavailable') {
        // Every failover leg is cooling or has no key — stop cleanly,
        // never spin. (Cookies/screenshot are attached by finish().)
        return finish('failed', { error: ERR_ALL_COOLING });
      }

      if (decision.action === 'observe') {
        consecutiveObserves += 1;
        if (consecutiveObserves > MAX_OBSERVE_RETRIES) {
          return finish('failed', { error: ERR_OBSERVE_LOOP });
        }
        safeUpdate('পাতা দেখা হচ্ছে · Observing page…', 40);
        await sleepCancellable(job, deadline, 2000);
        state = await observe(ctx.page);
        continue;
      }
      consecutiveObserves = 0;

      if (decision.action === 'fail') {
        return finish('failed', {
          error: decision.reason
            ? 'বিল্ড বন্ধ করা হয়েছে · Build stopped: ' + truncate(decision.reason, 200)
            : ERR_BUILD_FAILED,
        });
      }

      if (decision.action === 'done') {
        const found = completionFromState(state);
        if (found) {
          safeUpdate('অ্যাপ তৈরি · App ready', 100);
          return finish('built', { appUrl: found.appUrl, previewUrl: found.previewUrl });
        }
        if (decision.appUrl && /^https?:\/\//i.test(decision.appUrl)) {
          safeUpdate('অ্যাপ তৈরি · App ready', 100);
          return finish('built', { appUrl: decision.appUrl, previewUrl: decision.appUrl });
        }
        return finish('failed', { error: ERR_DONE_NO_URL });
      }

      if (decision.action === 'fill_prompt') {
        safeUpdate('নির্দেশনা লেখা হচ্ছে · Writing prompt: ' + truncate(prompt, 80), 50);
        await fillPrompt(ctx.page, prompt);
        promptFilled = true;
        checkCancelled(job);
        state = await observe(ctx.page);
        continue;
      }

      if (decision.action === 'click_build') {
        if (!promptFilled) {
          // Never build an empty prompt box: fill first, then click.
          safeUpdate('নির্দেশনা লেখা হচ্ছে · Writing prompt: ' + truncate(prompt, 80), 50);
          await fillPrompt(ctx.page, prompt);
          promptFilled = true;
          checkCancelled(job);
        }
        safeUpdate('Build করা হচ্ছে · Building…', 60);
        await clickBuild(ctx.page);
        buildClicked = true;
        checkCancelled(job);
        break; // -> phase B: poll every 15s until built / failed / timeout.
      }
    }

    // (10) Post-build polling: observe every 15s.
    let failureRetries = 0;
    for (;;) {
      await sleepCancellable(job, deadline, POLL_INTERVAL_MS);
      checkCancelled(job);
      checkDeadline(job, deadline);
      safeUpdate('বিল্ড দেখা হচ্ছে · Checking build…', 75);
      state = await observe(ctx.page);

      const done = completionFromState(state);
      if (done) {
        safeUpdate('অ্যাপ তৈরি · App ready', 100);
        return finish('built', { appUrl: done.appUrl, previewUrl: done.previewUrl });
      }
      if (isLoginRequiredState(ctx.page, state)) {
        return finish('login-required', { error: ERR_LOGIN_REQUIRED });
      }
      if (await helpers.isChallengePage(ctx.page)) {
        return finish('failed', { error: ERR_CHALLENGE });
      }
      if (FAILURE_TEXT_RE.test(state.visibleText || '')) {
        if (failureRetries < MAX_FAILURE_RETRIES) {
          failureRetries += 1;
          safeUpdate('আবার চেষ্টা করা হচ্ছে · Retrying build…', 70);
          await sleepCancellable(job, deadline, FAILURE_RETRY_WAIT_MS);
          await clickBuild(ctx.page);
          continue;
        }
        return finish('failed', { error: ERR_BUILD_FAILED });
      }
      // Otherwise keep polling until the deadline.
    }
  } catch (err) {
    if (err instanceof FlowStop) {
      if (err.status === 'cancelled') return finish('cancelled', { error: ERR_CANCELLED });
      if (err.status === 'timeout') return finish('timeout', { error: ERR_TIMEOUT });
      return finish('failed', { error: err.message || ERR_BUILD_FAILED });
    }
    const msg = err && err.message ? truncate(String(err.message), 300) : '';
    return finish('failed', {
      error: msg
        ? 'বিল্ড ব্যর্থ হয়েছে · Build failed: ' + msg
        : ERR_BUILD_FAILED,
    });
  } finally {
    if (ctx.context && pool) {
      await pool.release(ctx.context).catch(() => {});
    }
  }
}

module.exports = { runAiStudioBuild, isAgentLlmConfigured, agentLlmStatus };
