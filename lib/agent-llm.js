'use strict';
/**
 * lib/agent-llm.js — the shared LLM client for the Nexus browser worker's
 * server-side agents (the AI Studio build driver in lib/aistudio-agent.js
 * and the general browser-interaction loop in lib/browser-agent.js).
 *
 * Extracted verbatim out of lib/aistudio-agent.js (head 17999e9) with NO
 * behaviour change: the dedicated key slots, the failover chain, the
 * per-model health / RPM budgets / cooldowns, the per-leg HTTP calls and
 * the reply parser all moved here untouched. Both agents call the same
 * functions, so a fix to the failover machinery fixes both.
 *
 * DESIGN RULES (inherited from aistudio-agent.js — do not break these):
 *  - LLM spec (decided by the user 2026-11-23 21:20): provider is
 *    Google AI Studio (Gemini), primary model gemini-3.6-flash, key
 *    from the DEDICATED server env slot BROWSER_AGENT_GEMINI_KEY.
 *    Failover, own slots only, in order: gemini-3.6-flash (same key)
 *    -> gemini-3.1-flash-lite (same key) -> OpenRouter
 *    qwen/qwen3-coder:free (own slot BROWSER_AGENT_OPENROUTER_KEY).
 *    NEVER Groq, NEVER any chat agent's key. Keys come from env vars
 *    ONLY and are read fresh on every decision (no caching).
 *  - The API key is NEVER logged and NEVER included in results,
 *    steps, params, or error strings. Error bodies are logged
 *    truncated to 500 chars (they travel without the key, which is
 *    sent in a header only).
 *  - No new npm dependencies: Node 20 built-ins + global fetch.
 */

const LLM_TIMEOUT_MS = 20000; // per-LLM-call timeout

// Failover chain (fixed order — see header). Gemini legs share the one
// dedicated Gemini key; the OpenRouter leg has its own dedicated key.
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const CHAIN = ['gemini-3.6-flash', 'gemini-3.1-flash-lite', 'openrouter/qwen/qwen3-coder:free'];
const DEFAULT_RPM_BUDGET = 30; // per model, per 60s window
const RPM_WINDOW_MS = 60 * 1000;
const COOLDOWN_DEFAULT_MS = 60 * 1000; // 429/503 with no Retry-After
const COOLDOWN_BAD_REQUEST_MS = 5 * 60 * 1000; // other 4xx: bad key etc.

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
    // Log Google's exact error (status + message) so a rejected key can be
    // diagnosed: the agent used to discard it and report only 'bad-request'.
    // The error body never contains the key (the key travels in a header
    // only), so logging a truncated copy of it is safe.
    try {
      const detail = (await res.text() || '').slice(0, 500);
      console.error('[agent-llm] ' + leg.kind + ' ' + leg.id + ' -> HTTP ' + res.status + ' ' + detail);
    } catch (_) { /* body unreadable; keep the status-only path below */ }
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

module.exports = {
  agentKeys,
  buildLegs,
  pickLeg,
  callLeg,
  parseActionReply,
  agentLlmStatus,
  isAgentLlmConfigured,
  anyLegConfigured,
};
