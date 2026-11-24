'use strict';
/**
 * Server guardrails for the Nexus browser-interaction loop.
 *
 * Pure functions only: no Playwright, no network, no I/O, no logging of
 * field values, passwords, or keys. Worker B's loop engine calls these
 * by name — do not rename the exports.
 *
 * Relationship to the existing server (head 17999e9):
 *  - This module COMPLEMENTS the server's isChallengePage() helper in
 *    server.js (title + body-text check after navigation). It never
 *    replaces it: isChallengePage stays the primary challenge detector;
 *    detectBotCheck() here is the snapshot-level second line.
 *  - Nothing here attempts to circumvent a CAPTCHA, bot check, or
 *    paywall. The research report (sections 5 and 7) records that
 *    Meta's terms forbid such circumvention and that an independent
 *    test saw a refusal; a single researcher's claim that
 *    CAPTCHA-defeating skills exist is unverified and is NOT built
 *    here. When a bot check is detected the loop must pause and hand
 *    control to the user.
 *  - Shopping searches do not route to Amazon by default (research
 *    report section 7, Meta-documented default); isAmazonUrl() is
 *    the check the loop uses for that.
 *
 * Pattern lists are Nexus's own choices. The research report documents
 * NO pattern list for any of these checks, so the lists below were
 * chosen here and are deliberately small and conservative:
 *  - scanPageText(): false negatives are acceptable; false positives
 *    that block ordinary pages are not. A bare word is therefore
 *    never enough on its own — e.g. "must" in normal prose, or a
 *    neutral mention of "system prompt" in an article about AI, does
 *    NOT block. A pattern only fires when instruction-like language
 *    is aimed at the agent (a verb directed at the agent's own
 *    instructions, credentials, or safety behaviour, or a
 *    credential-harvesting lure).
 *  - detectCheckout() / detectBotCheck() / detectOtpRequest() use
 *    the signal lists from the task spec, applied to the
 *    accessibility snapshot (string, or an array/object of nodes
 *    with role/name/label/autocomplete).
 *  - classifyFormRisk(): 'high' means the form touches money,
 *    identity documents, account creation with a password, or an
 *    irreversible action. High-risk forms are filled but NOT
 *    submitted without user confirmation (the caller enforces that;
 *    this function only classifies).
 */

const INJECTION_REASON =
  'সন্দেহজনক নির্দেশমূলক লেখা পাওয়া গেছে — পৃষ্ঠার লেখা এজেন্টের নির্দেশ হিসেবে নেওয়া হবে না · ' +
  'Suspicious instruction-like text found — page text will not be treated as agent instructions';

const OTP_REASON =
  'একবারের যাচাই কোড দরকার — এজেন্ট আপনার ইনবক্স থেকে কোড পড়তে পারে না; কোডটি আপনাকেই দিতে হবে, ব্রাউজারের নিয়ন্ত্রণ নিন · ' +
  'A one-time verification code is needed — the agent cannot read codes from your inbox by design; ' +
  'you must enter the code yourself by taking control of the browser';

// ---------------------------------------------------------------------------
// Prompt-injection scan (page text AND downloaded-file text).
// Each pattern needs agent-directed language, not a bare keyword:
//   1. ignore / disregard / forget + previous instructions (or "your" ones)
//   2. a verb ordering the agent to expose its system prompt / instructions
//   3. a verb ordering the agent to send/share its credentials or keys
//   4. "click here to claim" / prize-claim lures (credential harvesting)
//   5. "you must" / "you are instructed to" + an agent-action verb
//   6. bypass / circumvent safety, security, or verification
//   7. an order to hide something from the user
//   8. "follow / obey my instructions" (page author addressing the agent)
// Deliberately NOT blocked on their own: "must" in normal prose,
// "system prompt" mentioned neutrally, "enter your password" (ordinary
// login-page text — only send/share/provide credentials is blocked).
// ---------------------------------------------------------------------------
const INJECTION_PATTERNS = [
  // 1. Ignore / disregard / forget previous (or your) instructions.
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|original)\s+(instructions?|rules?|directions?|guidelines?)\b/i,
  /\b(ignore|disregard)\s+(your|the)\s+(instructions?|rules?|directions?)\b/i,
  // 2. Reveal / disclose the system prompt or the agent's instructions.
  /\b(reveal|show|share|disclose|print|output)\b[^.\n]{0,40}\bsystem prompt\b/i,
  /\b(reveal|disclose|share)\b[^.\n]{0,40}\byour\s+(instructions?|credentials?|password)\b/i,
  // 3. Send / share / provide credentials, passwords, or keys.
  /\b(send|share|provide|give|email|message)\b[^.\n]{0,30}\b(your\s+)?(credentials?|passwords?|api[- ]?keys?|secret keys?|login details)\b/i,
  // 4. "Click here to claim" / prize-claim lures.
  /\bclick here to claim\b/i,
  /\bclaim\s+(your|the|a)\s+(prize|reward|gift|refund|winnings)\b/i,
  // 5. "You must ..." / "you are instructed to ..." with an agent action.
  /\byou must\s+(ignore|disregard|follow|obey|click|send|reveal|share|provide|bypass|disable|delete|run|execute|download|install)\b/i,
  /\byou are\s+(instructed|required|ordered)\s+to\b/i,
  // 6. Bypass / circumvent safety, security, or verification.
  /\b(bypass|circumvent)\b[^.\n]{0,30}\b(safety|security|guardrails?|captcha|verification)\b/i,
  /\bdisable\b[^.\n]{0,20}\b(guardrails?|safety filters?)\b/i,
  // 7. Hide something from the user.
  /\b(do not|don't|never)\s+(tell|mention|inform|warn|show)\s+the user\b/i,
  // 8. "Follow / obey my instructions" — the page author addressing the agent.
  /\b(follow|obey)\s+my\s+(instructions?|orders?)\b/i,
];

/**
 * Scan page text (or downloaded-file text) for prompt-injection patterns.
 * @param {string} text
 * @returns {{ blocked: boolean, reason: string }} — reason is BN+EN and
 *   never echoes the suspicious text.
 */
function scanPageText(text) {
  if (typeof text !== 'string' || !text) return { blocked: false, reason: '' };
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return { blocked: true, reason: INJECTION_REASON };
  }
  return { blocked: false, reason: '' };
}

// ---------------------------------------------------------------------------
// Snapshot helpers. A snapshot is usually the accessibility-tree text
// (string); an array of nodes or an object with a text/snapshot field is
// also accepted so Worker B can pass structured snapshots through.
// ---------------------------------------------------------------------------
function nodeToText(node) {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object') {
    return [node.role, node.name, node.label, node.value, node.autocomplete, node.placeholder]
      .filter((part) => typeof part === 'string' && part)
      .join(' ');
  }
  return '';
}

function snapshotToText(snapshot) {
  if (typeof snapshot === 'string') return snapshot;
  if (Array.isArray(snapshot)) return snapshot.map(nodeToText).join('\n');
  if (snapshot && typeof snapshot === 'object') {
    if (typeof snapshot.text === 'string') return snapshot.text;
    if (typeof snapshot.snapshot === 'string') return snapshot.snapshot;
    return JSON.stringify(snapshot);
  }
  return '';
}

// Checkout / payment signals on buttons/textboxes, or a textbox with a
// cc-* autocomplete attribute.
const CHECKOUT_RE = /checkout|place order|confirm (payment|purchase|order)|pay now|card number|\bcvv\b|\bcvc\b/i;
const CC_AUTOCOMPLETE_RE = /autocomplete\s*=\s*["']?cc-|\bcc-(number|exp|csc|cvc|name|type)\b/i;

/**
 * True when the snapshot contains checkout/payment signals.
 * @param {string|Array|object} snapshot
 * @returns {boolean}
 */
function detectCheckout(snapshot) {
  const text = snapshotToText(snapshot);
  if (!text) return false;
  return CHECKOUT_RE.test(text) || CC_AUTOCOMPLETE_RE.test(text);
}

// Bot-check signals. The server's isChallengePage() stays the primary
// detector; this is the snapshot-level second line.
const BOT_CHECK_RE = /captcha|verify (you are|you're) human|are you a robot|bot check|human verification|unusual traffic/i;

/**
 * True when the snapshot text looks like a CAPTCHA / bot check.
 * Detection only — never an attempt to solve or bypass it.
 * @param {string|Array|object} snapshot
 * @returns {boolean}
 */
function detectBotCheck(snapshot) {
  const text = snapshotToText(snapshot);
  if (!text) return false;
  return BOT_CHECK_RE.test(text);
}

// amazon.* hosts (amazon.com, amazon.co.uk, amazon.in, amazon.com.au,
// ...). Subdomains (www., smile.) are Amazon; fakeamazon.com is not.
const AMAZON_HOST_RE = /(^|\.)amazon\.[a-z]{2,}(\.[a-z]{2,})?$/i;

/**
 * True for amazon.* hosts. Shopping searches do not route to Amazon
 * by default.
 * @param {string} url
 * @returns {boolean}
 */
function isAmazonUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (_) {
    try {
      host = new URL('https://' + url.trim()).hostname;
    } catch (_) {
      return false;
    }
  }
  return AMAZON_HOST_RE.test(host.toLowerCase());
}

// One-time / verification-code request on textboxes/labels.
const OTP_RE = /one[- ]time (code|password)|verification code|enter the code|6[- ]digit code|\botp\b/i;

/**
 * True when the snapshot asks for a one-time/verification code.
 * @param {string|Array|object} snapshot
 * @returns {{ needsUser: boolean, reason: string }} — reason is BN+EN:
 *   the agent cannot read codes from the user's inbox by design; the
 *   user must take control.
 */
function detectOtpRequest(snapshot) {
  const text = snapshotToText(snapshot);
  if (!text || !OTP_RE.test(text)) return { needsUser: false, reason: '' };
  return { needsUser: true, reason: OTP_REASON };
}

// ---------------------------------------------------------------------------
// Form risk classification.
// 'high' when the form touches money, identity documents, account
// creation with a password, or an irreversible action. Field names /
// labels are matched, plus the snapshot text (button / heading names).
// "card" is matched as a whole word (or credit/debit card) so that an
// unrelated word such as "cardigan" does not trip it.
// ---------------------------------------------------------------------------
const HIGH_RISK_RE =
  /(credit|debit)[- ]?card|\bcard\b|cardholder|payment|\bprice\b|\bssn\b|passport|delete account|close account|confirm purchase|confirm payment|cancel (my )?(account|subscription)/i;
const ACCOUNT_CREATION_RE = /create (an |your )?account|sign ?up|register (an |your )?account|new account/i;

function fieldsToText(fields) {
  if (!Array.isArray(fields)) return '';
  return fields
    .map((field) => {
      if (typeof field === 'string') return field;
      if (field && typeof field === 'object') {
        return [field.label, field.name, field.placeholder, field.type, field.autocomplete]
          .filter((part) => typeof part === 'string' && part)
          .join(' ');
      }
      return '';
    })
    .join('\n');
}

/**
 * Classify a form's risk.
 * @param {Array} fields - [{ label?, name?, placeholder?, type?, ... }]
 * @param {string|Array|object} snapshot
 * @returns {'low'|'high'} — high-risk forms are filled but NOT submitted
 *   without user confirmation (enforced by the caller).
 */
function classifyFormRisk(fields, snapshot) {
  const haystack = fieldsToText(fields) + '\n' + snapshotToText(snapshot);
  if (!haystack.trim()) return 'low';
  if (HIGH_RISK_RE.test(haystack)) return 'high';
  const hasPasswordField =
    Array.isArray(fields) &&
    fields.some(
      (field) =>
        field &&
        typeof field === 'object' &&
        ((typeof field.type === 'string' && field.type.toLowerCase() === 'password') ||
          (typeof field.name === 'string' && /pass(word)?/i.test(field.name)) ||
          (typeof field.label === 'string' && /pass(word)?/i.test(field.label))),
    );
  if (hasPasswordField && ACCOUNT_CREATION_RE.test(haystack)) return 'high';
  return 'low';
}

module.exports = {
  scanPageText,
  detectCheckout,
  detectBotCheck,
  isAmazonUrl,
  detectOtpRequest,
  classifyFormRisk,
};
