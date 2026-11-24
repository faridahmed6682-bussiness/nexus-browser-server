'use strict';
/**
 * lib/browser-agent.js — general browser-interaction loop for the Nexus
 * browser worker.
 *
 * One job, one task, one loop: observe the page as an accessibility-tree
 * snapshot -> ask the dedicated LLM for ONE action from a fixed
 * vocabulary -> act -> take a FRESH snapshot -> repeat. The loop never
 * sees raw DOM/HTML, never gets a screenshot, and never runs JavaScript
 * in the page; everything it perceives comes from lib/browser-loop.js
 * (Playwright's accessibility tree) and everything it acts on is
 * grounded by role + accessible name in that tree.
 *
 * WHAT IS META-DOCUMENTED vs WHAT IS NEXUS'S OWN CHOICE
 * (research report ~/workspace/research_notes/muse-browser-interaction-
 * process-20261123-1759/report.md, sections 3, 5, 6, 7):
 *  - Meta-documented: the browser sub-agent sees an accessibility-tree
 *    snapshot, not the raw DOM; it has no JS/DevTools access; it grounds
 *    elements by role + accessible name; it re-reads the tree after
 *    acting (the tree "catches up" after a click); on a block it
 *    reroutes to another retailer or reports failure rather than
 *    retrying the same click; checkout detection prompts human approval
 *    with the exact purchase details; CAPTCHAs/paywalls must not be
 *    circumvented; OTPs are unreadable to the agent by design, so the
 *    user takes control; shopping searches exclude Amazon by default.
 *  - Nexus's own choice (Meta publishes NONE of these): the fixed action
 *    vocabulary below; the 30-step cap; the 15s per-Playwright-op and
 *    20s per-LLM-call timeouts; the wait clamp (10s); the
 *    3-consecutive-failures abort; the duplicate-trial cap (3, in
 *    lib/browser-loop.js); the shopping-task heuristic; the
 *    checkout-page scoping rule (see guardrailCheck); the
 *    needs-confirmation pause for high-risk form submits. Every such
 *    number/rule is labelled "Nexus's own choice" where it appears.
 *
 * DESIGN RULES (do not break these):
 *  - Same dedicated LLM keys as the build agent
 *    (BROWSER_AGENT_GEMINI_KEY / BROWSER_AGENT_OPENROUTER_KEY, read
 *    fresh every call via lib/agent-llm.js) — never the chat agents'
 *    keys, never Groq.
 *  - The LLM ONLY picks the next action from the fixed vocabulary. It
 *    never runs code and never chooses selectors — all grounding and
 *    all Playwright calls live in this file (the engine).
 *  - NO silent retry of the same failed click: on failure the loop
 *    re-reads the tree, and the LLM must try a different element,
 *    reroute to another site, or fail with an explanation. A target
 *    that already failed is never acted on again in the same run.
 *  - Every executed step is logged into the job record (via update())
 *    with the snapshot diff proving its effect.
 *  - job._cancelled and the deadline are checked between EVERY step
 *    (FlowStop / sleepCancellable pattern, as in aistudio-agent.js).
 *  - Passwords, one-time codes and card secrets are NEVER typed by the
 *    model: a sensitive field (valueStripped in the tree) stops the run
 *    with status 'needs-user' instead. Field VALUES are never written
 *    to step logs; filledValues report password-like fields as
 *    '[hidden]' (same convention as lib/formfill.js).
 *  - The API key is NEVER logged and NEVER included in results, steps,
 *    params, or error strings. Cookies are never logged (only counts).
 *  - No new npm dependencies: Node 20 built-ins + the Playwright page
 *    object supplied via helpers.
 *
 * Wiring contract (server.js passes `helpers` in):
 *   helpers = { getPool, applyCookies, harvestCookies, applyStealth,
 *               takeSmallScreenshot, isChallengePage }
 *   runBrowserLoop(job, update, helpers) -> {
 *     ok, status, summary, error, details, filledValues, pendingAction,
 *     finalUrl, stepsTaken, cookies, screenshotBase64 }
 *   status: 'done' | 'failed' | 'blocked' | 'needs-approval'
 *           | 'needs-user' | 'cancelled' | 'timeout' | 'not-configured'
 *   'needs-confirmation' is the INTERIM status: while a high-risk form
 *   submit waits for the user, the job stays 'running' and job.result
 *   carries { status: 'needs-confirmation', filledValues,
 *   pendingAction, reason } so the app can show the filled values for
 *   review. POST /api/agent/browse/:id/confirm answers it; the final
 *   result after the answer is one of the statuses above.
 *   screenshotBase64 is a small screenshot for the user's live view
 *   only — it is NEVER fed to the LLM.
 *
 * Confirm / resume (in-memory only, keyed by job id):
 *   confirmBrowserLoop(jobId, confirmed) — the confirm route calls
 *   this; true continues the paused run to the submit, false cancels
 *   it. Returns the paused entry, or null when no run is paused for
 *   that id (the route answers 404). Paused runs are never swept by
 *   the job queue while they wait — but the run's own deadline and the
 *   job timeout still bound the wait: if the user never answers, the
 *   loop times out and the entry is dropped.
 */

const {
  buildLegs,
  pickLeg,
  callLeg,
  parseActionReply,
  anyLegConfigured,
} = require('./agent-llm');
const {
  snapshotTree,
  snapshotDiff,
  groundAction,
  locatorFor,
  duplicateTrialState,
  nextUntried,
} = require('./browser-loop');
const guardrails = require('./guardrails');

// ---------------------------------------------------------------------------
// Nexus's own choices — Meta publishes NONE of these numbers.
// ---------------------------------------------------------------------------
const MAX_LOOP_STEPS = 30; // hard step cap per job (Nexus's own choice)
const OP_TIMEOUT_MS = 15000; // per-Playwright-op timeout (Nexus's own choice)
const MAX_WAIT_MS = 10000; // wait action clamp (Nexus's own choice)
const DEFAULT_MAX_MINUTES = 10;
const MAX_MAX_MINUTES = 60;
const MAX_CONSECUTIVE_FAILURES = 3; // failed actions in a row, then fail (Nexus's own choice)
const MAX_CONSECUTIVE_UNPARSABLE = 2; // unparsable LLM replies, then fail (Nexus's own choice)
const MAX_TREE_NODES_FOR_LLM = 80; // nodes pasted into one LLM call (Nexus's own choice)
const MAX_LLM_CONTEXT_CHARS = 8000; // JSON context cap per LLM call (Nexus's own choice)
const CONFIRM_POLL_MS = 500; // how often the paused run checks for an answer

// Fixed action vocabulary (Nexus's own choice — Meta publishes no
// vocabulary; see the research report, section 3c).
const LOOP_ACTIONS = new Set([
  'navigate', 'click', 'type', 'select', 'scroll', 'back', 'wait',
  'screenshot', 'done', 'fail',
]);

// Button names that mean "submit this form" (mirrors lib/formfill.js
// SUBMIT_BUTTON_RE) and names that mean "pay / buy" (mirrors its
// PAY_BUTTON_RE). A pay-like click is a purchase, never a plain submit.
const SUBMIT_BUTTON_RE = /submit|log ?in|sign ?in|continue|next|send|search|save/i;
const PAY_BUTTON_RE = /pay|checkout|place order|confirm (payment|purchase|order)|buy now/i;

// Shopping-task heuristic (Nexus's own choice): only shopping tasks get
// the Amazon reroute. A task that merely mentions a price in passing
// still counts — that errs towards rerouting, which is the safe side.
const SHOPPING_TASK_RE = /buy|price|cheapest|cheap|shop|order|purchase|deal|compare/i;

// URL paths that mean "this IS a checkout/payment page" (Nexus's own
// choice — see guardrailCheck for why the URL matters).
const CHECKOUT_URL_RE = /check ?out|cart|payment|billing|\/pay|\/order/i;
const PAYMENT_FIELD_RE = /card number|\bcvv\b|\bcvc\b|expiry|expiration date/i;

// Field names whose filled value must never be reported back.
const SENSITIVE_FIELD_RE = /pass(word)?|otp|verification code|cvv|cvc/i;

// User-facing errors are BN+EN.
const ERR_NOT_CONFIGURED =
  'ব্রাউজিং এজেন্টের API কী সেট করা হয়নি — সার্ভারে BROWSER_AGENT_GEMINI_KEY দিন · Browse agent API key is not configured — set BROWSER_AGENT_GEMINI_KEY on the server';
const ERR_NO_TASK =
  'ব্রাউজ করার নির্দেশনা দেওয়া হয়নি · No browse task was provided';
const ERR_INVALID_URL =
  'সঠিক URL দিন — http:// বা https:// দিয়ে শুরু হতে হবে · Invalid URL — must start with http:// or https://';
const ERR_CHALLENGE =
  'ক্যাপচা/যাচাই ধরা পড়েছে — মানুষের যাচাই দরকার · Captcha/challenge detected — needs a human';
const ERR_BOT_CHECK =
  'বট যাচাই ধরা পড়েছে — মানুষের যাচাই দরকার, এজেন্ট এটি এড়িয়ে যাবে না · Bot check detected — needs a human; the agent will not bypass it';
const ERR_OTP =
  'একবারের যাচাই কোড দরকার — এজেন্ট আপনার ইনবক্স থেকে কোড পড়তে পারে না; কোডটি আপনাকেই দিতে হবে · A one-time verification code is needed — the agent cannot read codes from your inbox by design; you must enter the code yourself';
const ERR_CREDENTIAL_FIELD =
  'পাসওয়ার্ড/গোপন তথ্যের ঘর পাওয়া গেছে — এজেন্ট পাসওয়ার্ড টাইপ করে না; লগইনটি আপনাকেই করতে হবে · A password/secret field was found — the agent never types passwords; please log in yourself';
const ERR_CHECKOUT =
  'চেকআউট পাতা ধরা পড়েছে — কেনাকাটা শেষ করার আগে আপনার অনুমোদন দরকার · Checkout page detected — your approval is needed before completing the purchase';
const ERR_HIGH_RISK_FORM =
  'উচ্চ-ঝুঁকির ফর্ম পূরণ হয়েছে — জমা দেওয়ার আগে আপনার নিশ্চিতকরণ দরকার · A high-risk form is filled — your confirmation is needed before submitting';
const ERR_AMAZON =
  'Amazon-এ এজেন্ট দিয়ে কেনাকাটা/খোঁজা যায় না — অন্য দোকানের নাম বা লিংক দিন · Amazon blocks agent shopping — please name another retailer or link';
const ERR_CANCELLED =
  'কাজ বন্ধ করে দেওয়া হয়েছে · Work was cancelled';
const ERR_TIMEOUT =
  'সময় শেষ — নির্ধারিত সময়ের মধ্যে ব্রাউজিং শেষ হয়নি · Timed out — the browse did not finish in time';
const ERR_ALL_COOLING =
  'সব এজেন্ট মডেল এখন ঠান্ডা হচ্ছে — একটু পরে আবার চেষ্টা করুন · All agent models are cooling down — try again shortly';
const ERR_TOO_MANY_STEPS =
  '৩০ ধাপ পেরিয়ে গেছে, কাজ শেষ হয়নি · Step limit reached (30 steps) without finishing';
const ERR_REPEATED_FAILURES =
  'পরপর কয়েকটি কাজ ব্যর্থ হয়েছে — অন্য উপায় না পেয়ে থামা হলো · Several actions in a row failed — stopping instead of repeating them';
const ERR_LLM_UNPARSABLE =
  'এজেন্টের উত্তর বোঝা যায়নি — কয়েকবার চেষ্টার পর থামা হলো · The agent reply could not be understood after several tries';
const ERR_CONFIRM_DECLINED =
  'আপনি জমা দিতে অস্বীকৃতি জানিয়েছেন — কাজ বন্ধ করা হলো · You declined the submit — work was cancelled';
const ERR_POOL =
  'ব্রাউজার পাওয়া যায়নি — আবার চেষ্টা করুন · Browser unavailable — try again';

// ---------------------------------------------------------------------------
// Small utilities (same patterns as aistudio-agent.js).
// ---------------------------------------------------------------------------
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

function isHttpUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// First http(s) URL mentioned inside a task string, or null.
function extractUrlFromTask(task) {
  if (typeof task !== 'string') return null;
  const m = task.match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

/** URL without its query string, for step logs (a query can carry a token). */
function logSafeUrl(url) {
  if (typeof url !== 'string') return '';
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

/** Snapshot nodes as plain text (role + name + non-secret value), for guardrails. */
function treeToText(tree) {
  if (!tree) return '';
  if (typeof tree === 'string') return tree;
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  return nodes
    .map((n) => {
      if (!n || typeof n !== 'object') return '';
      const parts = [n.role, n.name];
      if (typeof n.value === 'string' && n.value) parts.push(n.value);
      return parts.filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join('\n');
}

function nodeByRef(tree, ref) {
  const nodes = Array.isArray(tree && tree.nodes) ? tree.nodes : [];
  return nodes.find((n) => n && n.ref === ref) || null;
}

/** One-line summary of a snapshot diff, for the job's step log. */
function diffSummary(diff) {
  if (!diff || typeof diff !== 'object') return 'পরিবর্তন দেখা যায়নি · no visible change';
  const added = Array.isArray(diff.added) ? diff.added : [];
  const removed = Array.isArray(diff.removed) ? diff.removed : [];
  const changed = Array.isArray(diff.changed) ? diff.changed : [];
  const bits = [];
  if (added.length) {
    const names = added.slice(0, 3)
      .map((n) => (n.role || '') + ' "' + (n.name || '') + '"')
      .join(', ');
    bits.push('+' + added.length + ' ' + names);
  }
  if (removed.length) bits.push('−' + removed.length + ' removed');
  if (changed.length) bits.push('~' + changed.length + ' changed');
  if (diff.truncated) bits.push('(truncated)');
  return bits.length ? bits.join('; ') : 'পরিবর্তন দেখা যায়নি · no visible change';
}

/** Visible checkout details for a needs-approval stop: page text + URL. */
function purchaseDetails(tree) {
  return truncate(treeToText(tree), 800);
}

// ---------------------------------------------------------------------------
// Paused confirmation runs — in-memory map keyed by job id.
//   entry = { confirmed: null|boolean, filledValues, pendingAction, at }
// The loop sets job.result to the interim 'needs-confirmation' record
// while it waits, so the app sees the filled values by polling
// GET /api/job/:id. confirmBrowserLoop() answers the wait; the loop
// itself deletes the entry on every exit (see the finally in
// runBrowserLoop).
// ---------------------------------------------------------------------------
const pausedConfirmations = new Map();

/** The paused entry for a job id, or null when no run is paused for it. */
function getPausedConfirmation(jobId) {
  return pausedConfirmations.get(jobId) || null;
}

/**
 * Answer a paused 'needs-confirmation' run. Returns the entry, or null
 * when no run is paused for that id (the route answers 404).
 */
function confirmBrowserLoop(jobId, confirmed) {
  const entry = pausedConfirmations.get(jobId);
  if (!entry) return null;
  entry.confirmed = Boolean(confirmed);
  return entry;
}

/**
 * Pause the run for a high-risk form submit. Resolves true when the user
 * confirms (the caller then performs the pending submit), false when the
 * user declines. Throws FlowStop on cancel / deadline while waiting.
 */
async function awaitConfirmation(job, deadline, filledValues, pendingAction, safeUpdate) {
  const entry = {
    confirmed: null,
    filledValues: Array.isArray(filledValues) ? filledValues : [],
    pendingAction: pendingAction || null,
    at: new Date().toISOString(),
  };
  pausedConfirmations.set(job.id, entry);
  // Interim record, visible to the app via GET /api/job/:id while the
  // job stays 'running'. runJob() overwrites job.result with the final
  // result when the handler returns.
  job.result = {
    status: 'needs-confirmation',
    filledValues: entry.filledValues,
    pendingAction: entry.pendingAction,
    reason: ERR_HIGH_RISK_FORM,
  };
  safeUpdate('নিশ্চিতকরণ দরকার — ফর্ম পূরণ হয়েছে, জমা দেওয়া থামানো আছে · Needs your confirmation — form filled, submit paused…');
  try {
    for (;;) {
      if (entry.confirmed !== null) return entry.confirmed;
      checkCancelled(job);
      checkDeadline(job, deadline);
      await sleep(CONFIRM_POLL_MS);
    }
  } finally {
    pausedConfirmations.delete(job.id);
  }
}

// ---------------------------------------------------------------------------
// Guardrails — run on every fresh snapshot, before the LLM decides.
// ---------------------------------------------------------------------------
/**
 * Returns { stop: null | { status, error, details? }, checkoutSignal: bool }.
 *
 * Checkout scoping (Nexus's own choice): lib/guardrails.js's
 * detectCheckout() fires on any checkout/payment signal in the tree —
 * including a shop header's "Checkout" link. Stopping on that alone
 * would end every shopping task on the store's homepage, before any
 * purchase exists. So a per-iteration stop needs the signal PLUS
 * evidence this page IS a checkout (checkout-like URL path, or a
 * payment field on the page). The fail-closed point is the submit
 * click itself: before any submit-like click, ANY checkout signal
 * stops the run with 'needs-approval' (see the click branch).
 */
function guardrailCheck(tree, url) {
  let scan = { blocked: false, reason: '' };
  try {
    scan = guardrails.scanPageText(treeToText(tree)) || scan;
  } catch (_) { /* a guardrail miss must not kill the run */ }
  if (scan && scan.blocked) {
    return { stop: { status: 'blocked', error: scan.reason || ERR_CHALLENGE }, checkoutSignal: false };
  }

  let bot = false;
  try { bot = guardrails.detectBotCheck(tree) === true; } catch (_) { bot = false; }
  if (bot) {
    return { stop: { status: 'blocked', error: ERR_BOT_CHECK }, checkoutSignal: false };
  }

  let otp = { needsUser: false, reason: '' };
  try { otp = guardrails.detectOtpRequest(tree) || otp; } catch (_) { otp = { needsUser: false, reason: '' }; }
  if (otp && otp.needsUser) {
    return { stop: { status: 'needs-user', error: otp.reason || ERR_OTP }, checkoutSignal: false };
  }

  let checkoutSignal = false;
  try { checkoutSignal = guardrails.detectCheckout(tree) === true; } catch (_) { checkoutSignal = false; }
  if (checkoutSignal) {
    let onCheckoutPage = false;
    try { onCheckoutPage = CHECKOUT_URL_RE.test(new URL(url || '').pathname); } catch (_) { onCheckoutPage = false; }
    if (!onCheckoutPage) onCheckoutPage = PAYMENT_FIELD_RE.test(treeToText(tree));
    if (onCheckoutPage) {
      return {
        stop: { status: 'needs-approval', error: ERR_CHECKOUT, details: purchaseDetails(tree) },
        checkoutSignal: true,
      };
    }
    // Signal only (e.g. a header link) — note it, keep going. The
    // submit-click check below is the fail-closed point.
  }
  return { stop: null, checkoutSignal };
}

// ---------------------------------------------------------------------------
// LLM decision — fixed action vocabulary only, never code, never selectors.
// ---------------------------------------------------------------------------
const LOOP_SYSTEM_PROMPT =
  'You drive a web browser to complete the user\'s task. You see an accessibility-tree snapshot of the page: each element has a role, an accessible name, and a state. You never see the raw page, DOM, or a screenshot. Reply with JSON only — exactly one action per reply.\n\n' +
  'Actions (reply with exactly one):\n' +
  '{"action":"navigate","url":"https://...","reason":"..."}\n' +
  '{"action":"click","role":"button","name":"Add to cart","reason":"..."}\n' +
  '{"action":"type","role":"textbox","name":"Search","text":"granola bars","reason":"..."}\n' +
  '{"action":"select","role":"combobox","name":"Size","value":"Large","reason":"..."}\n' +
  '{"action":"scroll","direction":"down","reason":"..."}\n' +
  '{"action":"back","reason":"..."}\n' +
  '{"action":"wait","ms":2000,"reason":"..."}\n' +
  '{"action":"screenshot","reason":"..."}\n' +
  '{"action":"done","summary":"...","reason":"..."}\n' +
  '{"action":"fail","reason":"..."}\n\n' +
  'Rules:\n' +
  '- Use ONLY role/name pairs that appear in the snapshot. Never invent a button or field name. An icon-only control with no name cannot be clicked.\n' +
  '- If a target already failed, pick a DIFFERENT element, another site, or fail — never repeat the same failed click.\n' +
  '- Never type a password, one-time code, or card secret: if the task needs one, reply fail with reason "needs user".\n' +
  '- Shopping search: never navigate to Amazon — use the other retailers named in the task.\n' +
  '- Reply done only when the task goal is visibly achieved; say what was achieved in summary.\n' +
  '- If you are stuck, reply fail with a clear reason instead of repeating actions.';

/**
 * Ask the LLM for the next loop action, walking the failover chain in
 * order. Returns the parsed action, { action: 'unavailable' } when every
 * leg is cooling/unavailable, or { action: 'unparsable', reason } when
 * the reply is not usable JSON / not in the vocabulary.
 */
async function decideLoopAction(task, tree, stepNo, recentSteps, lastError, failedTargets) {
  const compactTree = {
    url: tree && typeof tree.url === 'string' ? tree.url : '',
    title: tree && typeof tree.title === 'string' ? tree.title : '',
    nodes: Array.isArray(tree && tree.nodes) ? tree.nodes.slice(0, MAX_TREE_NODES_FOR_LLM) : [],
    truncated: Boolean(tree && tree.truncated)
      || (Array.isArray(tree && tree.nodes) && tree.nodes.length > MAX_TREE_NODES_FOR_LLM),
  };
  const userContent = JSON.stringify({
    task: truncate(task, 1000),
    step: stepNo,
    maxSteps: MAX_LOOP_STEPS,
    tree: compactTree,
    recentSteps: Array.isArray(recentSteps) ? recentSteps.slice(-5) : [],
    lastError: lastError || '',
    alreadyFailedTargets: [...failedTargets].slice(0, 10),
  }).slice(0, MAX_LLM_CONTEXT_CHARS);
  const legs = buildLegs();
  const tried = new Set();
  for (;;) {
    const leg = pickLeg(legs, tried);
    if (!leg) return { action: 'unavailable', reason: 'all legs cooling or unavailable' };
    tried.add(leg.id);
    const result = await callLeg(leg, LOOP_SYSTEM_PROMPT, userContent);
    if (result.error) continue; // cooled (or transient) — try the next leg
    const parsed = parseActionReply(result.text || '');
    if (!parsed || typeof parsed !== 'object') {
      return { action: 'unparsable', reason: 'llm reply was not JSON' };
    }
    const action = typeof parsed.action === 'string' ? parsed.action : '';
    if (!LOOP_ACTIONS.has(action)) {
      return { action: 'unparsable', reason: 'unknown action: ' + truncate(action, 50) };
    }
    return { ...parsed, action };
  }
}

// ---------------------------------------------------------------------------
// Amazon reroute (Meta-documented default: shopping searches exclude
// Amazon unless the user asked for it — research report, section 7).
// ---------------------------------------------------------------------------
function isShoppingTask(task) {
  return SHOPPING_TASK_RE.test(task || '');
}

/** First non-Amazon URL named in the task text, or null. */
function amazonRerouteTarget(task) {
  const urls = String(task || '').match(/https?:\/\/[^\s"'<>]+/g) || [];
  for (const u of urls) {
    try {
      if (!guardrails.isAmazonUrl(u)) return u;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function isAmazonUrlSafe(url) {
  try {
    return guardrails.isAmazonUrl(url) === true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
async function runBrowserLoop(job, update, helpers) {
  // Step updates, plus the job's live page URL (A1 mini-browser
  // mirroring): every update also forwards the page's current URL to
  // the job store, which exposes it as the job's top-level
  // `currentUrl` (GET /api/job/:id). The URL is read live from
  // ctx.page.url() — the same value snapshotTree() records as
  // tree.url (lib/browser-loop.js reads page.url() itself), so it is
  // never staler than the snapshot the loop is deciding from, and it
  // stays fresh across navigations that happen between snapshots.
  // No call site changes: every existing safeUpdate(text, progress)
  // call — including the confirmation-pause update via
  // awaitConfirmation — now carries the URL. The URL is a separate
  // update argument, never written into the step text.
  const safeUpdate = (text, progress) => {
    try {
      if (typeof update === 'function') {
        let url = '';
        try {
          url = ctx.page && typeof ctx.page.url === 'function' ? ctx.page.url() : '';
        } catch (_) {
          url = '';
        }
        update(text, progress, url || undefined);
      }
    } catch (_) { /* step logging must never break the run */ }
  };
  const params = (job && job.params) || {};
  const task = typeof params.task === 'string' ? params.task : '';
  const startUrl = (typeof params.url === 'string' && params.url)
    ? params.url
    : extractUrlFromTask(task);
  const maxMinutesRaw = Number(params.maxMinutes);
  const maxMinutes = Number.isFinite(maxMinutesRaw) && maxMinutesRaw > 0
    ? Math.min(maxMinutesRaw, MAX_MAX_MINUTES)
    : DEFAULT_MAX_MINUTES;
  const deadline = Date.now() + maxMinutes * 60 * 1000;

  // Terminal-result builder: harvests cookies on every terminal return
  // and attaches a small screenshot (user live view only, never fed to
  // the LLM) when one was taken during the run, or takes one
  // best-effort at the end. `ctx` is { context, page }, filled in as
  // the run proceeds.
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
    let screenshotBase64 = latestScreenshot;
    if (!screenshotBase64 && ctx.page && helpers && typeof helpers.takeSmallScreenshot === 'function'
      && status !== 'not-configured' && status !== 'cancelled') {
      try {
        const shot = await helpers.takeSmallScreenshot(ctx.page, {});
        screenshotBase64 = shot && shot.jpegBase64 ? shot.jpegBase64 : null;
      } catch (_) {
        screenshotBase64 = null;
      }
    }
    return {
      ok: status === 'done',
      status,
      summary: o.summary || null,
      error: o.error || null,
      details: o.details || null,
      filledValues: o.filledValues || null,
      pendingAction: o.pendingAction || null,
      finalUrl: o.finalUrl || null,
      stepsTaken,
      cookies: Array.isArray(cookies) ? cookies : [],
      screenshotBase64,
    };
  };

  const ctx = { context: null, page: null };
  let stepsTaken = 0;
  let latestScreenshot = null;

  // 0. Dedicated-LLM config gate — no browser is launched when no leg
  // has a key. (The run gate is any-leg, so an OpenRouter-only setup
  // can still run via the last failover leg.)
  if (!anyLegConfigured()) {
    return finish('not-configured', { error: ERR_NOT_CONFIGURED });
  }
  if (!task.trim()) {
    return finish('failed', { error: ERR_NO_TASK });
  }
  if (startUrl && !isHttpUrl(startUrl)) {
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

  // Per-run state.
  const filledFields = []; // { label, name, value } — '[hidden]' for sensitive fields
  const filledValues = () => filledFields.map((f) => ({ label: f.label, value: f.value }));
  const failedTargets = new Set(); // 'role\0name' — never acted on again
  const trialStates = new Map(); // (role\0name) -> duplicateTrialState()
  const recentSteps = []; // last actions, for the LLM's context
  let lastError = '';
  let consecutiveFailures = 0;
  let consecutiveUnparsable = 0;

  // Ground a { role, name } target. Duplicate names are disambiguated by
  // trial, one candidate at a time (research report, section 2: the
  // agent learns what a person sees at a glance only by trying each
  // option and re-reading the tree). One trial state per (role, name);
  // the 3-trial cap lives in lib/browser-loop.js.
  const groundTarget = (tree, role, name) => {
    const g = groundAction(tree, { role, name });
    if (g && g.error === 'duplicate') {
      const key = (role || '') + '\0' + String(name || '').toLowerCase();
      let state = trialStates.get(key);
      if (!state) {
        state = duplicateTrialState();
        trialStates.set(key, state);
      }
      const ref = nextUntried(g.candidates, state);
      if (!ref) return { error: 'duplicate-exhausted', candidates: g.candidates };
      return { ref, node: nodeByRef(tree, ref), duplicate: true };
    }
    if (g && g.error) return { error: g.error };
    if (!g || !g.ref) return { error: 'not-found' };
    return { ref: g.ref, node: nodeByRef(tree, g.ref) };
  };

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

    // (2) Apply per-request session cookies, open a page, stealth.
    safeUpdate('সেশন লাগানো হচ্ছে · Applying session…', 10);
    await helpers.applyCookies(ctx.context, params.cookies);
    checkCancelled(job);
    ctx.page = await ctx.context.newPage();
    await helpers.applyStealth(ctx.page);
    checkCancelled(job);

    // (3) Open the start URL when the task names one; otherwise the
    // loop starts on about:blank and the LLM navigates first.
    if (startUrl) {
      if (isShoppingTask(task) && isAmazonUrlSafe(startUrl)) {
        const alt = amazonRerouteTarget(task);
        if (alt) {
          safeUpdate('Amazon বাদ দিয়ে অন্য দোকানে যাওয়া হচ্ছে · Rerouting away from Amazon…', 12);
          await ctx.page.goto(alt, { waitUntil: 'domcontentloaded', timeout: OP_TIMEOUT_MS });
        } else {
          return finish('failed', { error: ERR_AMAZON });
        }
      } else {
        safeUpdate('পাতা খোলা হচ্ছে · Opening page…', 15);
        await ctx.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: OP_TIMEOUT_MS });
      }
      await ctx.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      checkCancelled(job);
      checkDeadline(job, deadline);
    }

    // (4) Challenge / CAPTCHA check (primary detector, server helper).
    if (await helpers.isChallengePage(ctx.page)) {
      return finish('blocked', { error: ERR_CHALLENGE });
    }

    // (5) First snapshot + guardrails, before any decision.
    let tree = await snapshotTree(ctx.page);
    let guards = guardrailCheck(tree, tree.url || ctx.page.url());
    if (guards.stop) {
      return finish(guards.stop.status, {
        error: guards.stop.error,
        details: guards.stop.details || null,
        finalUrl: tree.url || ctx.page.url(),
      });
    }
    safeUpdate('পাতা দেখা হচ্ছে · Observing page…', 20);
    checkCancelled(job);
    checkDeadline(job, deadline);

    // (6) The loop: observe -> LLM decides ONE action -> act -> FRESH
    // snapshot -> repeat, until done / failed / blocked / a guardrail
    // stop / cancel / deadline / the 30-step cap.
    for (let stepNo = 1; stepNo <= MAX_LOOP_STEPS; stepNo += 1) {
      checkCancelled(job);
      checkDeadline(job, deadline);

      // Guardrails on the current tree, every iteration, before acting.
      guards = guardrailCheck(tree, tree.url || ctx.page.url());
      if (guards.stop) {
        return finish(guards.stop.status, {
          error: guards.stop.error,
          details: guards.stop.details || null,
          finalUrl: tree.url || ctx.page.url(),
          filledValues: filledFields.length ? filledValues() : null,
        });
      }
      if (await helpers.isChallengePage(ctx.page)) {
        return finish('blocked', { error: ERR_CHALLENGE, finalUrl: ctx.page.url() });
      }

      // Amazon reroute on the current page (shopping tasks only).
      if (isShoppingTask(task) && isAmazonUrlSafe(tree.url || ctx.page.url())) {
        const alt = amazonRerouteTarget(task);
        if (alt) {
          safeUpdate('Amazon বাদ দিয়ে অন্য দোকানে যাওয়া হচ্ছে · Rerouting away from Amazon…', 20);
          try {
            await ctx.page.goto(alt, { waitUntil: 'domcontentloaded', timeout: OP_TIMEOUT_MS });
          } catch (err) {
            return finish('failed', {
              error: 'অন্য দোকানে যাওয়া যায়নি · Could not reroute: ' + truncate(String(err.message || err), 200),
            });
          }
          tree = await snapshotTree(ctx.page);
          continue;
        }
        return finish('failed', { error: ERR_AMAZON, finalUrl: tree.url || ctx.page.url() });
      }

      // (7) Ask the dedicated LLM for the next action only.
      safeUpdate('ধাপ ' + stepNo + '/' + MAX_LOOP_STEPS + ' — পরের কাজ ঠিক করা হচ্ছে · Deciding step ' + stepNo + '…', 20 + Math.round((stepNo / MAX_LOOP_STEPS) * 70));
      const decision = await decideLoopAction(task, tree, stepNo, recentSteps, lastError, failedTargets);
      checkCancelled(job);
      checkDeadline(job, deadline);

      if (decision.action === 'unavailable') {
        // Every failover leg is cooling or has no key — stop cleanly,
        // never spin. (Cookies/screenshot are attached by finish().)
        return finish('failed', { error: ERR_ALL_COOLING, finalUrl: tree.url || ctx.page.url() });
      }

      if (decision.action === 'unparsable') {
        consecutiveUnparsable += 1;
        if (consecutiveUnparsable > MAX_CONSECUTIVE_UNPARSABLE) {
          return finish('failed', { error: ERR_LLM_UNPARSABLE, finalUrl: tree.url || ctx.page.url() });
        }
        lastError = decision.reason || 'llm reply unparsable';
        recentSteps.push({ action: '?', outcome: 'failed: ' + lastError });
        safeUpdate('এজেন্টের উত্তর বোঝা যায়নি, আবার দেখা হচ্ছে · Reply unclear, re-observing…');
        tree = await snapshotTree(ctx.page).catch(() => tree);
        continue;
      }
      consecutiveUnparsable = 0;

      if (decision.action === 'done') {
        const summary = typeof decision.summary === 'string' && decision.summary
          ? decision.summary
          : (typeof decision.reason === 'string' ? decision.reason : '');
        safeUpdate('কাজ শেষ · Done', 100);
        return finish('done', {
          summary: truncate(summary, 500),
          finalUrl: tree.url || ctx.page.url(),
          filledValues: filledFields.length ? filledValues() : null,
        });
      }

      if (decision.action === 'fail') {
        return finish('failed', {
          error: decision.reason
            ? 'ব্যর্থ হয়েছে · Failed: ' + truncate(String(decision.reason), 200)
            : 'ব্যর্থ হয়েছে · Failed',
          finalUrl: tree.url || ctx.page.url(),
          filledValues: filledFields.length ? filledValues() : null,
        });
      }

      // One executed action. `noteFailure` records it without acting
      // again on the same target: the next iteration re-reads the tree
      // and the LLM must pick a different element, reroute, or fail.
      const before = tree;
      const targetKey = (role, name) => (role || '') + '\0' + String(name || '').toLowerCase();
      const noteFailure = (msg) => {
        consecutiveFailures += 1;
        lastError = msg;
        recentSteps.push({ action: decision.action, outcome: 'failed: ' + msg });
        safeUpdate('ধাপ ' + stepNo + ': ব্যর্থ · Failed — ' + msg);
      };
      const noteSuccess = (label) => {
        consecutiveFailures = 0;
        lastError = '';
        stepsTaken += 1;
        recentSteps.push({ action: decision.action, outcome: 'ok' });
      };

      // Fresh snapshot + diff after the action, proving its effect.
      const afterAction = async (label) => {
        noteSuccess(label);
        let after = null;
        try {
          after = await snapshotTree(ctx.page);
        } catch (_) {
          after = null;
        }
        let diffText = 'পরিবর্তন দেখা যায়নি · no visible change';
        if (after) {
          try {
            diffText = diffSummary(snapshotDiff(before, after));
          } catch (_) {
            diffText = 'পরিবর্তন দেখা যায়নি · no visible change';
          }
          tree = after;
        }
        safeUpdate('ধাপ ' + stepNo + ': ' + label + ' — ' + diffText,
          20 + Math.round((stepNo / MAX_LOOP_STEPS) * 70));
      };

      if (decision.action === 'navigate') {
        if (!isHttpUrl(decision.url)) {
          noteFailure('bad navigate url from agent');
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
          }
          tree = await snapshotTree(ctx.page).catch(() => tree);
          continue;
        }
        if (isShoppingTask(task) && isAmazonUrlSafe(decision.url)) {
          const alt = amazonRerouteTarget(task);
          if (!alt) {
            return finish('failed', { error: ERR_AMAZON, finalUrl: tree.url || ctx.page.url() });
          }
          safeUpdate('Amazon বাদ দিয়ে অন্য দোকানে যাওয়া হচ্ছে · Rerouting away from Amazon…');
          try {
            await ctx.page.goto(alt, { waitUntil: 'domcontentloaded', timeout: OP_TIMEOUT_MS });
          } catch (err) {
            noteFailure('reroute failed: ' + truncate(String(err.message || err), 120));
            if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
              return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
            }
            tree = await snapshotTree(ctx.page).catch(() => tree);
            continue;
          }
          await ctx.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await afterAction('navigate to ' + logSafeUrl(alt));
          continue;
        }
        try {
          await ctx.page.goto(decision.url, { waitUntil: 'domcontentloaded', timeout: OP_TIMEOUT_MS });
        } catch (err) {
          noteFailure('navigate failed: ' + truncate(String(err.message || err), 120));
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
          }
          tree = await snapshotTree(ctx.page).catch(() => tree);
          continue;
        }
        await ctx.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await afterAction('navigate to ' + logSafeUrl(decision.url));
        continue;
      }

      if (decision.action === 'click' || decision.action === 'type' || decision.action === 'select') {
        const role = typeof decision.role === 'string' ? decision.role : '';
        const name = typeof decision.name === 'string' ? decision.name : '';
        if (!role || !name) {
          noteFailure('agent action missing role/name');
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
          }
          tree = await snapshotTree(ctx.page).catch(() => tree);
          continue;
        }
        if (failedTargets.has(targetKey(role, name))) {
          // Already failed once in this run — never silently retry it.
          noteFailure('target already failed earlier: ' + role + ' "' + name + '"');
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
          }
          tree = await snapshotTree(ctx.page).catch(() => tree);
          continue;
        }
        const grounded = groundTarget(tree, role, name);
        if (grounded.error) {
          failedTargets.add(targetKey(role, name));
          noteFailure('element not found: ' + role + ' "' + name + '" (' + grounded.error + ')');
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
          }
          tree = await snapshotTree(ctx.page).catch(() => tree);
          continue;
        }
        let locator = null;
        try {
          locator = await locatorFor(ctx.page, tree, grounded.ref);
        } catch (_) {
          locator = null;
        }
        if (!locator) {
          failedTargets.add(targetKey(role, name));
          noteFailure('element no longer resolves: ' + role + ' "' + name + '" (page changed)');
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
          }
          tree = await snapshotTree(ctx.page).catch(() => tree);
          continue;
        }

        if (decision.action === 'click') {
          // Purchase / submit gates — checked BEFORE acting.
          if (PAY_BUTTON_RE.test(name)) {
            // A pay/checkout/place-order click is a purchase: stop for
            // human approval with the exact visible details, never submit.
            return finish('needs-approval', {
              error: ERR_CHECKOUT,
              details: purchaseDetails(tree),
              finalUrl: tree.url || ctx.page.url(),
              filledValues: filledFields.length ? filledValues() : null,
              pendingAction: { action: 'click', role, name },
            });
          }
          if (SUBMIT_BUTTON_RE.test(name)) {
            let checkoutNow = false;
            try { checkoutNow = guardrails.detectCheckout(tree) === true; } catch (_) { checkoutNow = false; }
            if (checkoutNow || guards.checkoutSignal) {
              return finish('needs-approval', {
                error: ERR_CHECKOUT,
                details: purchaseDetails(tree),
                finalUrl: tree.url || ctx.page.url(),
                filledValues: filledFields.length ? filledValues() : null,
                pendingAction: { action: 'click', role, name },
              });
            }
            // High-risk form submit: fill only, never submit without the
            // user. Risk is classified by lib/guardrails.js
            // (classifyFormRisk — money, identity documents, account
            // creation with a password, irreversible actions); the
            // caller enforces the pause. filledValues follow
            // lib/formfill.js's contract: [{ label, value }], password
            // fields '[hidden]'.
            let risk = 'low';
            try {
              risk = guardrails.classifyFormRisk(filledFields, tree);
            } catch (_) {
              risk = 'high'; // fail closed when classification is unavailable
            }
            if (risk === 'high') {
              const confirmed = await awaitConfirmation(
                job, deadline, filledValues(),
                { action: 'click', role, name }, safeUpdate,
              );
              if (!confirmed) {
                return finish('cancelled', {
                  error: ERR_CONFIRM_DECLINED,
                  finalUrl: tree.url || ctx.page.url(),
                  filledValues: filledValues(),
                });
              }
              safeUpdate('নিশ্চিত করা হয়েছে, জমা দেওয়া হচ্ছে · Confirmed, submitting…');
            }
          }
          try {
            await locator.click({ timeout: OP_TIMEOUT_MS });
          } catch (err) {
            failedTargets.add(targetKey(role, name));
            noteFailure('click failed: ' + role + ' "' + name + '" — ' + truncate(String(err.message || err), 120));
            if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
              return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
            }
            tree = await snapshotTree(ctx.page).catch(() => tree);
            continue;
          }
          await afterAction('click ' + role + ' "' + name + '"');
          continue;
        }

        if (decision.action === 'type') {
          // Credentials are never typed by the model (Meta-documented):
          // a sensitive field stops the run so the user takes control.
          if (grounded.node && grounded.node.valueStripped === true) {
            return finish('needs-user', {
              error: ERR_CREDENTIAL_FIELD,
              finalUrl: tree.url || ctx.page.url(),
              filledValues: filledFields.length ? filledValues() : null,
            });
          }
          const text = typeof decision.text === 'string' ? decision.text : null;
          if (text === null) {
            noteFailure('type action missing text');
            if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
              return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
            }
            tree = await snapshotTree(ctx.page).catch(() => tree);
            continue;
          }
          try {
            await locator.fill(text, { timeout: OP_TIMEOUT_MS });
          } catch (err) {
            failedTargets.add(targetKey(role, name));
            noteFailure('type failed: ' + role + ' "' + name + '" — ' + truncate(String(err.message || err), 120));
            if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
              return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
            }
            tree = await snapshotTree(ctx.page).catch(() => tree);
            continue;
          }
          // Record what was filled (label + value, never logged). The
          // value is masked when the field looks secret-bearing.
          filledFields.push({
            label: name,
            name,
            value: SENSITIVE_FIELD_RE.test(name) ? '[hidden]' : text,
          });
          await afterAction('type into ' + role + ' "' + name + '"');
          continue;
        }

        // select
        const value = typeof decision.value === 'string' ? decision.value : null;
        if (value === null) {
          noteFailure('select action missing value');
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
          }
          tree = await snapshotTree(ctx.page).catch(() => tree);
          continue;
        }
        try {
          await locator.selectOption(value, { timeout: OP_TIMEOUT_MS });
        } catch (_) {
          try {
            await locator.selectOption({ label: value }, { timeout: OP_TIMEOUT_MS });
          } catch (err) {
            failedTargets.add(targetKey(role, name));
            noteFailure('select failed: ' + role + ' "' + name + '" — ' + truncate(String(err.message || err), 120));
            if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
              return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
            }
            tree = await snapshotTree(ctx.page).catch(() => tree);
            continue;
          }
        }
        await afterAction('select ' + role + ' "' + name + '"');
        continue;
      }

      if (decision.action === 'scroll') {
        const direction = decision.direction === 'up' ? 'up' : 'down';
        try {
          await ctx.page.mouse.wheel(0, direction === 'up' ? -600 : 600);
        } catch (err) {
          noteFailure('scroll failed: ' + truncate(String(err.message || err), 120));
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
          }
          tree = await snapshotTree(ctx.page).catch(() => tree);
          continue;
        }
        await afterAction('scroll ' + direction);
        continue;
      }

      if (decision.action === 'back') {
        try {
          await ctx.page.goBack({ timeout: OP_TIMEOUT_MS });
        } catch (err) {
          noteFailure('back failed: ' + truncate(String(err.message || err), 120));
          if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
          }
          tree = await snapshotTree(ctx.page).catch(() => tree);
          continue;
        }
        await afterAction('back');
        continue;
      }

      if (decision.action === 'wait') {
        const ms = typeof decision.ms === 'number' && Number.isFinite(decision.ms)
          ? Math.max(0, Math.min(decision.ms, MAX_WAIT_MS))
          : 1000;
        await sleepCancellable(job, deadline, ms);
        await afterAction('wait ' + ms + 'ms');
        continue;
      }

      if (decision.action === 'screenshot') {
        // User live view only — the image is attached to the job result
        // and is NEVER fed to the LLM.
        try {
          const shot = await helpers.takeSmallScreenshot(ctx.page, {});
          latestScreenshot = shot && shot.jpegBase64 ? shot.jpegBase64 : latestScreenshot;
        } catch (_) { /* a failed screenshot never fails the run */ }
        await afterAction('screenshot (live view only)');
        continue;
      }

      // Unreachable: decideLoopAction only returns LOOP_ACTIONS.
      noteFailure('unknown action from agent: ' + String(decision.action));
      if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        return finish('failed', { error: ERR_REPEATED_FAILURES, finalUrl: tree.url || ctx.page.url() });
      }
      tree = await snapshotTree(ctx.page).catch(() => tree);
    }

    // Step cap exhausted without done/fail.
    return finish('failed', {
      error: ERR_TOO_MANY_STEPS,
      finalUrl: tree.url || ctx.page.url(),
      filledValues: filledFields.length ? filledValues() : null,
    });
  } catch (err) {
    if (err instanceof FlowStop) {
      if (err.status === 'cancelled') return finish('cancelled', { error: ERR_CANCELLED });
      if (err.status === 'timeout') return finish('timeout', { error: ERR_TIMEOUT });
      return finish('failed', { error: err.message || 'ব্যর্থ হয়েছে · Failed' });
    }
    const msg = err && err.message ? truncate(String(err.message), 300) : '';
    return finish('failed', {
      error: msg
        ? 'ব্রাউজিং ব্যর্থ হয়েছে · Browse failed: ' + msg
        : 'ব্রাউজিং ব্যর্থ হয়েছে · Browse failed',
    });
  } finally {
    if (job && job.id) pausedConfirmations.delete(job.id);
    if (ctx.context && pool) {
      await pool.release(ctx.context).catch(() => {});
    }
  }
}

module.exports = {
  runBrowserLoop,
  confirmBrowserLoop,
  getPausedConfirmation,
  MAX_LOOP_STEPS,
};
