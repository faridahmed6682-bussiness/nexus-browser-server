'use strict';
/**
 * Nexus Browser Worker — heavy browser work for the Nexus AI Android app.
 *
 * The Android app cannot run full Chrome automation on-device, so this
 * server does it: full Chromium (Playwright), logins, file uploads,
 * multi-step flows — the same role Muse's cloud browser plays.
 *
 * Free-tier friendly by design:
 *  - one Chromium instance, one task at a time (simple queue, max 5 waiting)
 *  - a fresh browser context per task (no cookies/state leak between tasks)
 *  - pages/contexts closed after every task, 60s task timeout
 *  - launch args --no-sandbox --disable-dev-shm-usage for small containers
 *
 * Auth: every /api/* call must send header `x-api-key: <BROWSER_WORKER_KEY>`.
 * The key lives ONLY in the BROWSER_WORKER_KEY env var — never in code.
 * If the env var is not set, the API refuses everything (503).
 *
 * No state is kept between tasks: each task starts logged out. A login flow
 * must be scripted as steps (goto -> type user -> type pass -> click) every
 * time. Credentials pass through the server in the request; they are never
 * stored or logged.
 *
 * GitHub App support (optional): the Nexus app can connect to GitHub the
 * way Meta Muse does — via a GitHub App installation instead of a personal
 * token. GitHub sends installation events to POST /github/webhook (verified
 * with GITHUB_WEBHOOK_SECRET); the app requests a short-lived installation
 * access token from POST /api/github/installation-token (auth: x-api-key),
 * which this server mints by signing a JWT with GITHUB_APP_ID +
 * GITHUB_APP_PRIVATE_KEY and exchanging it at api.github.com. Installation
 * records live in memory and in github-installations.json (runtime state,
 * never committed). All GitHub secrets come only from env vars.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { JobQueue, TOO_MANY_JOBS_BN_EN } = require('./lib/jobQueue');
const { ContextPool } = require('./lib/contexts');
const { applyCookies, harvestCookies } = require('./lib/sessions');
const { applyStealth, DESKTOP_USER_AGENT, VIEWPORT, LOCALE, TIMEZONE_ID } = require('./lib/stealth');
const { takeSmallScreenshot } = require('./lib/screenshot');
const { captureDownload } = require('./lib/downloads');
const { fillForm } = require('./lib/formfill');
const { sendPush, maskToken } = require('./lib/push');
const { runAiStudioBuild, isAgentLlmConfigured, agentLlmStatus } = require('./lib/aistudio-agent');
const { runBrowserLoop, confirmBrowserLoop, getPausedConfirmation } = require('./lib/browser-agent');
const { searchWeb, searchStatus } = require('./lib/search');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || '60000', 10);
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || '5', 10);
const API_KEY = process.env.BROWSER_WORKER_KEY || '';
const STEP_TIMEOUT_DEFAULT = 15000;
const MAX_TEXT_CHARS = 20000;
// runTask contract (Android BrowserWorkerClient): POST /api/browse with
// {"task": "...", "url": "..."}. The task is the job instruction — e.g.
// "Open this Google Translate page and return ONLY the translated text".
// This server has no LLM, so it cannot interpret the instruction itself;
// it honours it by browsing the page the task names and returning the
// page text, which the app's model then uses. A task with no url field
// may name its page inside the task text ("Page: https://...").
const MAX_TASK_CHARS = 4000;

// GitHub App credentials — env vars only, never hardcoded or logged.
// The private key is often stored as one line with literal \n separators
// (Railway/Render env vars); convert those to real newlines for crypto.
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '';
const GITHUB_APP_PRIVATE_KEY = (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

const app = express();
app.use(express.json({
  limit: '1mb',
  // Keep the raw body: GitHub webhook signatures are computed over it.
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Minimal request log (no bodies, no headers — the API key must never be logged).
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(new Date().toISOString(), req.method, req.path, res.statusCode, Date.now() - started + 'ms');
  });
  next();
});

// ---------------------------------------------------------------------------
// Browser lifecycle: one shared Chromium instance, one context per task.
// ---------------------------------------------------------------------------
let browser = null;
let browserLaunching = null;

async function getBrowser() {
  if (browser) return browser;
  if (!browserLaunching) {
    browserLaunching = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions'],
    }).then((b) => {
      browser = b;
      browserLaunching = null;
      b.on('disconnected', () => { browser = null; pool = null; });
      return b;
    }).catch((err) => {
      browserLaunching = null;
      throw err;
    });
  }
  return browserLaunching;
}

async function closeBrowser() {
  const b = browser;
  browser = null;
  pool = null;
  if (b) await b.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// One-task-at-a-time queue (free-tier RAM) + per-task timeout.
// ---------------------------------------------------------------------------
let queue = Promise.resolve();
let queueLength = 0;

function runExclusive(fn) {
  if (queueLength >= MAX_QUEUE) {
    const err = new Error('busy: too many queued tasks, try again shortly');
    err.status = 429;
    return Promise.reject(err);
  }
  queueLength += 1;
  const task = queue.then(fn).finally(() => { queueLength -= 1; });
  queue = task.catch(() => {}); // keep the chain alive after failures
  return task;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('task timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Job queue + pooled contexts (new /api/job, /api/screenshot, /api/fill).
// The old /api/browse and /api/read endpoints keep their own one-at-a-time
// runExclusive() queue and are untouched. Cookies, keys, field values and
// request bodies are never logged anywhere in this section.
// ---------------------------------------------------------------------------
const jobs = new JobQueue({
  // Best-effort push on job completion: when a job finishes ('done') or
  // pauses needing the user ('paused-needs-user'), notify the app via FCM
  // if the job carried an fcmToken. A push failure never fails the job —
  // lib/jobQueue swallows callback errors, and this handler itself also
  // catches everything. No Firestore lookup here (follow-up): the token
  // must come in the job request body for now (see docs/PUSH_NOTIFICATIONS.md).
  onJobEvent: async (event, job) => {
    const token = job && job.params && typeof job.params.fcmToken === 'string'
      ? job.params.fcmToken
      : '';
    if (!token) return; // no device token known — nothing to notify
    const isPaused = event === 'paused-needs-user';
    const title = isPaused
      ? 'Nexus: আপনার সাহায্য দরকার · Needs you'
      : 'Nexus: কাজ শেষ · Job done';
    const body = isPaused
      ? 'কাজটি থেমে গেছে — ' + (job.result && job.result.reason ? job.result.reason : 'আপনার সাহায্য দরকার') + ' · Job ' + job.id.slice(0, 8) + ' paused and needs you.'
      : 'কাজটি শেষ হয়েছে · Job ' + job.id.slice(0, 8) + ' (' + job.type + ') is done.';
    try {
      await sendPush(token, {
        title,
        body,
        data: { jobId: job.id, type: job.type, event, status: job.status },
      });
    } catch (err) {
      // Best-effort only: log (token masked) and move on.
      console.warn('[push] job notify failed for ' + maskToken(token) + ': ' + (err && err.message ? err.message : err));
    }
  },
});
let pool = null;

// Lazily build the pool against the shared Chromium instance (created on
// first new-endpoint use). Reset to null on browser disconnect / shutdown
// (see getBrowser / closeBrowser) so a fresh pool is built next time.
async function getPool() {
  const b = await getBrowser();
  if (!pool) pool = new ContextPool(b, {
    maxContexts: 4,
    minFreeMemMB: 150,
    // Stealth desktop fingerprint at context level, so pooled contexts
    // carry the same UA/locale/timezone as one-off contexts (see
    // lib/stealth.js). applyStealth(page) still covers viewport +
    // init script on every page.
    newContextOptions: {
      userAgent: DESKTOP_USER_AGENT,
      locale: LOCALE,
      timezoneId: TIMEZONE_ID,
      viewport: { ...VIEWPORT },
    },
  });
  return pool;
}

const JOB_TYPES = new Set(['browse', 'read', 'screenshot', 'fill', 'download', 'aistudio-build']);
const INVALID_URL_BN_EN = 'সঠিক URL দিন — http:// বা https:// দিয়ে শুরু হতে হবে · Invalid URL — must start with http:// or https://';
const INVALID_JOB_TYPE_BN_EN = 'অজানা কাজের ধরন — browse, read, screenshot, fill বা download হতে হবে · Unknown job type — must be browse, read, screenshot, fill, or download';
const JOB_NOT_FOUND_BN_EN = 'কাজটি পাওয়া যায়নি · Job not found';
const JOB_NOT_PAUSED_BN_EN = 'এই কাজটি থেমে নেই — শুধু থেমে থাকা কাজ আবার শুরু করা যায় · Job is not paused — only a paused-needs-user job can be resumed';
const CAPTCHA_PAUSE_BN_EN = 'ক্যাপচা যাচাই দরকার — আপনার ব্রাউজারে যাচাইটি সম্পূর্ণ করুন · CAPTCHA verification needed — please complete it in your browser';
const SYNC_TIMEOUT_BN_EN = 'সময় শেষ — ৬০ সেকেন্ড পেরিয়ে গেছে · Timed out after 60 seconds';
const INVALID_FIELDS_BN_EN = 'fields একটি অ্যারে হতে হবে · fields must be an array';
const INVALID_PROMPT_BN_EN = 'প্রম্পট দরকার — খালি নয়, সর্বোচ্চ ৮০০০ অক্ষর · prompt is required — non-empty string, max 8000 characters';
const INVALID_TASK_BN_EN = 'কাজের নির্দেশনা দরকার — খালি নয়, সর্বোচ্চ ৪০০০ অক্ষর · task is required — non-empty string, max 4000 characters';
const BROWSE_NOT_PAUSED_BN_EN = 'এই ব্রাউজিং কাজটি নিশ্চিতকরণের অপেক্ষায় নেই · This browse job is not waiting for confirmation';
const INVALID_CONFIRMED_BN_EN = 'confirmed true বা false হতে হবে · confirmed must be true or false';
const INVALID_COOKIES_BN_EN = 'cookies একটি অ্যারে হতে হবে · cookies must be an array';
const INVALID_MAX_MINUTES_BN_EN = 'maxMinutes একটি সংখ্যা হতে হবে · maxMinutes must be a number';
const INVALID_FCM_TOKEN_BN_EN = 'fcmToken একটি স্ট্রিং হতে হবে · fcmToken must be a string';
const INVALID_SEARCH_QUERY_BN_EN = 'খোঁজার কথা দিন — খালি নয়, সর্বোচ্চ ৫০০ অক্ষর · q is required — a non-empty string, max 500 characters';
const JOB_ALREADY_TERMINAL_BN_EN = 'কাজটি ইতিমধ্যে শেষ হয়ে গেছে — বাতিল করা যাবে না · Job is already finished — it cannot be cancelled';

function isHttpUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Cheap CAPTCHA / bot-challenge sniff: page title + a short slice of the
// visible body text. Runs after navigation, before any result is stored.
const CHALLENGE_TITLE_RE = /captcha|verify you are human|are you a robot|just a moment|attention required|checking your browser/i;
const CHALLENGE_BODY_RE = /captcha|verify you are human|are you a robot/i;

async function isChallengePage(page) {
  try {
    const title = await page.title().catch(() => '');
    if (title && CHALLENGE_TITLE_RE.test(title)) return true;
  } catch (_) { /* ignore */ }
  try {
    const snippet = await page.evaluate(
      () => (document.body ? (document.body.innerText || '') : '').slice(0, 3000),
    ).catch(() => '');
    if (snippet && CHALLENGE_BODY_RE.test(snippet)) return true;
  } catch (_) { /* ignore */ }
  return false;
}

// Acquire one pooled context, run fn(context), always release it.
// A pool refusal (cap / low memory) is rethrown with status 429 and the
// module's exact BN+EN message so routes can answer 429 verbatim.
async function runPooled(fn) {
  const p = await getPool();
  let context;
  try {
    context = await p.acquire();
  } catch (err) {
    const e = new Error(err.message);
    e.status = 429;
    throw e;
  }
  try {
    return await fn(context);
  } finally {
    await p.release(context);
  }
}

// One job's browser work, inside a pooled context. Calls jobs.pauseJob()
// (and stops, returning null) when a CAPTCHA / challenge page is found;
// runJob() keeps the paused status instead of marking the job done/failed.
async function executeJobTask(job, update) {
  const p = job.params || {};
  const pPool = await getPool();
  let context;
  try {
    context = await pPool.acquire();
    await applyCookies(context, p.cookies);
    const page = await context.newPage();
    await applyStealth(page);

    if (p.type === 'download') {
      update('ডাউনলোড হচ্ছে · Downloading…', 20);
      const dl = await captureDownload(page, p.url, {});
      if (dl && dl.notAFile && (await isChallengePage(page))) {
        jobs.pauseJob(job.id, CAPTCHA_PAUSE_BN_EN, p.url);
        return null;
      }
      const cookies = await harvestCookies(context).catch(() => []);
      return { ...dl, cookies };
    }

    update('পৃষ্ঠা খোলা হচ্ছে · Opening page…', 10);
    await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_DEFAULT });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    if (await isChallengePage(page)) {
      jobs.pauseJob(job.id, CAPTCHA_PAUSE_BN_EN, p.url);
      return null;
    }

    let result;
    if (p.type === 'screenshot') {
      update('স্ক্রিনশট নেওয়া হচ্ছে · Taking screenshot…', 60);
      result = await takeSmallScreenshot(page, { selector: p.selector, clip: p.clip });
    } else if (p.type === 'fill') {
      update('ফর্ম পূরণ করা হচ্ছে · Filling form…', 60);
      result = await fillForm(page, Array.isArray(p.fields) ? p.fields : [], {
        submit: Boolean(p.submit),
        allowPassword: Boolean(p.allowPassword),
        checkoutApproved: Boolean(p.checkoutApproved),
      });
    } else {
      // browse / read — same text-extraction path, inside a pooled context.
      update('পাঠ্য পড়া হচ্ছে · Reading text…', 60);
      const text = await readVisibleText(page);
      const clipped = truncate(text);
      result = {
        text: clipped.text,
        truncated: clipped.truncated,
        title: await page.title().catch(() => ''),
        url: page.url(),
      };
    }
    const cookies = await harvestCookies(context).catch(() => []);
    return { ...result, cookies };
  } finally {
    await pPool.release(context);
  }
}

// Sync (single-request) runners for POST /api/screenshot and /api/fill.
async function runPooledScreenshot(url, opts) {
  return runPooled(async (context) => {
    await applyCookies(context, opts.cookies);
    const page = await context.newPage();
    await applyStealth(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_DEFAULT });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const shot = await takeSmallScreenshot(page, { selector: opts.selector, clip: opts.clip });
    const cookies = await harvestCookies(context);
    return { ok: true, url: page.url(), title: await page.title().catch(() => ''), ...shot, cookies };
  });
}

async function runPooledFill(url, opts) {
  return runPooled(async (context) => {
    await applyCookies(context, opts.cookies);
    const page = await context.newPage();
    await applyStealth(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_DEFAULT });
    const r = await fillForm(page, opts.fields, {
      submit: Boolean(opts.submit),
      allowPassword: Boolean(opts.allowPassword),
      checkoutApproved: Boolean(opts.checkoutApproved),
    });
    const cookies = await harvestCookies(context);
    return { ok: true, ...r, cookies };
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({ ok: false, error: 'server misconfigured: BROWSER_WORKER_KEY is not set' });
  }
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------
async function readVisibleText(page) {
  const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
  return (text || '').trim();
}

function truncate(text) {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

async function runSteps(page, steps) {
  let lastText = null;
  let screenshotBase64 = null;

  for (const step of steps || []) {
    const timeout = step.timeoutMs || STEP_TIMEOUT_DEFAULT;
    switch (step.action) {
      case 'goto':
        await page.goto(step.url || step.text, { waitUntil: 'domcontentloaded', timeout });
        break;
      case 'click':
        await page.click(step.selector, { timeout });
        break;
      case 'type':
        // fill = clear + type (dispatches real input events, works for React forms)
        await page.fill(step.selector, step.text || '', { timeout });
        break;
      case 'select': {
        try {
          await page.selectOption(step.selector, step.text, { timeout });
        } catch (e) {
          await page.selectOption(step.selector, { label: step.text }, { timeout });
        }
        break;
      }
      case 'wait':
        if (step.selector) {
          await page.waitForSelector(step.selector, { timeout });
        } else {
          await page.waitForTimeout(Math.min(step.timeoutMs || 1000, 30000));
        }
        break;
      case 'readText':
        lastText = await readVisibleText(page);
        break;
      case 'screenshot': {
        const buf = await page.screenshot({ type: 'png' });
        screenshotBase64 = buf.toString('base64');
        break;
      }
      default:
        throw new Error('unknown step action: ' + step.action);
    }
  }
  return { lastText, screenshotBase64 };
}

async function runBrowse(url, steps, task, cookies) {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    // Shared Google login: the phone stores the Google session cookies
    // encrypted and sends them per request; the server keeps nothing
    // after the context closes (see lib/sessions.js). Cookies need a
    // domain — applyCookies silently skips domain-less entries.
    await applyCookies(context, cookies);
    const page = await context.newPage();
    const targetUrl = url || extractUrlFromTask(task);
    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_DEFAULT });
    }
    const { lastText, screenshotBase64 } = await runSteps(page, steps);
    const text = lastText !== null ? lastText : await readVisibleText(page);
    const clipped = truncate(text);
    const out = {
      ok: true,
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: clipped.text,
      truncated: clipped.truncated,
      result: clipped.text,
    };
    if (typeof task === 'string' && task) out.task = task;
    if (screenshotBase64) out.screenshotBase64 = screenshotBase64;
    // Return the refreshed session cookies so the phone can store them
    // back (same shape as the /api/job result).
    out.cookies = await harvestCookies(context).catch(() => []);
    return out;
  } finally {
    await context.close().catch(() => {});
  }
}

// First http(s) URL mentioned inside a task string, or null. Lets a
// task-only call (no url field) name its own page, e.g. translate and
// free-chat tasks that carry "Page: https://...".
function extractUrlFromTask(task) {
  if (typeof task !== 'string') return null;
  const m = task.match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

async function runRead(url) {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_DEFAULT });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const text = await readVisibleText(page);
    const clipped = truncate(text);
    return {
      ok: true,
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: clipped.text,
      truncated: clipped.truncated,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// GitHub App support
//
//  1. GitHub sends installation events to POST /github/webhook. The HMAC
//     SHA-256 signature (x-hub-signature-256) is verified against
//     GITHUB_WEBHOOK_SECRET over the raw request body.
//  2. Records live in memory and in github-installations.json (runtime
//     state file, written on every event). Railway/Render filesystems are
//     ephemeral without a volume, so the file is a convenience, not a
//     guarantee — the app should treat an empty list as "unknown", not
//     "no installations".
//  3. POST /api/github/installation-token mints a short-lived installation
//     access token (GitHub expires these within ~1 hour) by signing a JWT
//     (RS256, max 10 min lifetime) and exchanging it at api.github.com.
// ---------------------------------------------------------------------------
const GITHUB_STATE_FILE = path.join(__dirname, 'github-installations.json');
const MAX_RECENT_EVENTS = 50;

// installationId (string) -> { installationId, account, repositories, status, updatedAt, lastEvent }
const installations = new Map();
let recentEvents = [];

function loadInstallations() {
  try {
    if (!fs.existsSync(GITHUB_STATE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(GITHUB_STATE_FILE, 'utf8'));
    if (Array.isArray(data.installations)) {
      for (const rec of data.installations) {
        if (rec && rec.installationId) installations.set(String(rec.installationId), rec);
      }
    }
    if (Array.isArray(data.recentEvents)) recentEvents = data.recentEvents.slice(0, MAX_RECENT_EVENTS);
  } catch (err) {
    console.warn('could not load GitHub installation state:', err.message);
  }
}

function saveInstallations() {
  try {
    const tmp = GITHUB_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ installations: [...installations.values()], recentEvents }, null, 2));
    fs.renameSync(tmp, GITHUB_STATE_FILE);
  } catch (err) {
    console.warn('could not save GitHub installation state:', err.message);
  }
}

loadInstallations();

function recordEvent(type, installationId, detail) {
  recentEvents.unshift({
    type,
    installationId: installationId != null ? String(installationId) : null,
    detail: detail || null,
    at: new Date().toISOString(),
  });
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.length = MAX_RECENT_EVENTS;
}

function repoNames(repos) {
  if (!Array.isArray(repos)) return [];
  return repos.map((r) => (typeof r === 'string' ? r : r.full_name || r.name)).filter(Boolean);
}

function upsertInstallation(payload, eventType) {
  const inst = payload.installation;
  if (!inst || inst.id == null) return null;
  const id = String(inst.id);
  const existing = installations.get(id) || { installationId: id, repositories: [], status: 'active' };
  if (inst.account) {
    existing.account = { id: inst.account.id, login: inst.account.login, type: inst.account.type };
  }
  if (Array.isArray(payload.repositories)) existing.repositories = repoNames(payload.repositories);
  existing.status = 'active';
  existing.updatedAt = new Date().toISOString();
  existing.lastEvent = eventType;
  installations.set(id, existing);
  return existing;
}

// -- Webhook signature (HMAC SHA-256 over the raw body, timing-safe) --------
function verifyGitHubSignature(req) {
  const signature = req.header('x-hub-signature-256') || '';
  if (!signature.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// -- GitHub App JWT (RS256, issued 60s in the past, valid 9 minutes) ---------
function buildGitHubAppJwt() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const data = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iat: now - 60, exp: now + 540, iss: GITHUB_APP_ID });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), GITHUB_APP_PRIVATE_KEY);
  return data + '.' + sig.toString('base64url');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'nexus-browser-worker',
    endpoints: ['GET /health', 'POST /api/browse', 'POST /api/read', 'POST /api/search', 'POST /api/job', 'GET /api/job/:id', 'GET /api/jobs', 'POST /api/job/:id/resume', 'POST /api/job/:id/cancel', 'POST /api/agent/build', 'POST /api/agent/browse', 'POST /api/agent/browse/:id/confirm', 'POST /api/screenshot', 'POST /api/fill', 'POST /github/webhook', 'POST /api/github/installation-token', 'GET /api/github/installations', 'POST /api/notify'],
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'up',
    browser: browser ? 'ready' : 'idle',
    queuedTasks: queueLength,
    uptimeSec: Math.floor(process.uptime()),
  });
});

app.post('/api/browse', requireAuth, async (req, res) => {
  const { url, steps, task, cookies } = req.body || {};
  if (task !== undefined && typeof task !== 'string') {
    return res.status(400).json({ ok: false, error: 'task must be a string' });
  }
  if (typeof task === 'string' && task.length > MAX_TASK_CHARS) {
    return res.status(400).json({ ok: false, error: 'task must be at most 4000 characters' });
  }
  const hasGoto = Array.isArray(steps) && steps.some((s) => s && s.action === 'goto');
  const taskUrl = extractUrlFromTask(task);
  // The app's reachability check posts {"task": "ping"} with no url.
  // Answer it without launching a browser.
  if (typeof task === 'string' && task.trim() === 'ping' && !url && !hasGoto && !taskUrl) {
    return res.json({ ok: true, task: 'ping', result: 'pong', text: 'pong' });
  }
  if (!url && !hasGoto && !taskUrl) {
    return res.status(400).json({ ok: false, error: 'url, a goto step, or a task containing a URL is required' });
  }
  if (steps !== undefined && !Array.isArray(steps)) {
    return res.status(400).json({ ok: false, error: 'steps must be an array' });
  }
  if (cookies !== undefined && !Array.isArray(cookies)) {
    return res.status(400).json({ ok: false, error: 'cookies must be an array' });
  }
  try {
    const result = await runExclusive(() => withTimeout(runBrowse(url, steps, task, cookies), TASK_TIMEOUT_MS));
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

app.post('/api/read', requireAuth, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url is required' });
  }
  try {
    const result = await runExclusive(() => withTimeout(runRead(url), TASK_TIMEOUT_MS));
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

// ---------------------------------------------------------------------------
// Web search: Google Custom Search (free 100/day) + DuckDuckGo fallback.
// POST /api/search {q} -> {ok, provider, results, quotaRemaining}.
// lib/search.js tries Google first; on any Google failure, on quota
// exhaustion, or when the CSE keys are unset, it falls back to the
// DuckDuckGo HTML endpoint (plain HTTP, no browser). The CSE key is
// never logged or returned — lib/search.js logs only the provider,
// the HTTP status and the remaining quota. On total failure (both
// providers down) this answers 502 and the app falls back to opening
// the DuckDuckGo search URL in the browser worker (unchanged path).
// ---------------------------------------------------------------------------
app.post('/api/search', requireAuth, async (req, res) => {
  const q = (req.body || {}).q;
  if (typeof q !== 'string' || !q.trim() || q.trim().length > 500) {
    return res.status(400).json({ ok: false, error: INVALID_SEARCH_QUERY_BN_EN });
  }
  try {
    const result = await searchWeb(q.trim());
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'খোঁজা যায়নি — Google ও DuckDuckGo দুটোই সাড়া দেয়নি · Search failed — both Google and DuckDuckGo are unreachable' });
  }
});

// ---------------------------------------------------------------------------
// Job queue + pooled-context endpoints (new; old endpoints above untouched).
// Error responses here are JSON { error: "<BN+EN string>" }.
// ---------------------------------------------------------------------------

function createJob(req, res) {
  const body = req.body || {};
  const { type, url } = body;
  if (!JOB_TYPES.has(type)) {
    return res.status(400).json({ error: INVALID_JOB_TYPE_BN_EN });
  }
  if (!isHttpUrl(url)) {
    return res.status(400).json({ error: INVALID_URL_BN_EN });
  }
  if (type === 'fill' && !Array.isArray(body.fields)) {
    return res.status(400).json({ error: INVALID_FIELDS_BN_EN });
  }
  const jobId = jobs.createJob(type, {
    type,
    url,
    selector: body.selector,
    clip: body.clip,
    fields: body.fields,
    submit: body.submit,
    allowPassword: body.allowPassword,
    checkoutApproved: body.checkoutApproved,
    cookies: body.cookies,
    // Optional FCM device token: when the job finishes or pauses needing
    // the user, the server sends a push to this token (lib/push.js).
    // Stored in params only — never logged, never in publicJob() output.
    fcmToken: typeof body.fcmToken === 'string' ? body.fcmToken : undefined,
  });
  if (!jobId) {
    return res.status(429).json({ error: TOO_MANY_JOBS_BN_EN });
  }
  const job = jobs.getJob(jobId);
  // Fire and forget: the app polls GET /api/job/:id for the result.
  jobs.runJob(job, (j, update) => executeJobTask(j, update)).catch(() => {});
  return res.status(202).json({ jobId });
}

app.post('/api/job', requireAuth, createJob);
app.post('/api/jobs', requireAuth, createJob);

function getJob(req, res) {
  const job = jobs.publicJob(req.params.id);
  if (!job) return res.status(404).json({ error: JOB_NOT_FOUND_BN_EN });
  delete job._runId; // internal run guard — not part of the public view
  delete job._cancelled; // internal cancel flag — not part of the public view
  jobs.markFetched(req.params.id);
  return res.json(job);
}

app.get('/api/job/:id', requireAuth, getJob);
app.get('/api/jobs/:id', requireAuth, getJob);

app.get('/api/jobs', requireAuth, (req, res) => {
  res.json({ ok: true, jobs: jobs.listJobs() });
});

function resumeJob(req, res) {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: JOB_NOT_FOUND_BN_EN });
  const resumed = jobs.resumeJob(req.params.id);
  if (!resumed) return res.status(400).json({ error: JOB_NOT_PAUSED_BN_EN });
  const freshCookies = (req.body || {}).cookies;
  if (Array.isArray(freshCookies)) resumed.params.cookies = freshCookies;
  // A resumed job may carry a fresh FCM token (device token can rotate).
  if (typeof (req.body || {}).fcmToken === 'string') resumed.params.fcmToken = req.body.fcmToken;
  jobs.runJob(resumed, (j, update) => executeJobTask(j, update)).catch(() => {});
  return res.json({ ok: true, status: resumed.status });
}

app.post('/api/job/:id/resume', requireAuth, resumeJob);
app.post('/api/jobs/:id/resume', requireAuth, resumeJob);

// ---------------------------------------------------------------------------
// AI Studio build agent (server-side, lib/aistudio-agent.js).
// POST /api/agent/build creates a long 'aistudio-build' job that drives an
// AI Studio build end-to-end (open page, paste prompt, click Build, wait,
// fix errors, return the result). The agent runs on its OWN dedicated LLM
// keys (BROWSER_AGENT_GEMINI_KEY, BROWSER_AGENT_OPENROUTER_KEY) — never
// the chat agents' keys and never Groq — so one agent's quota running out
// never stops the others. No 503 here when that key is unconfigured: the
// job itself finishes fast with status 'not-configured', so the app (and
// the dry-run check) sees a clear job record instead of a bare error.
// ---------------------------------------------------------------------------
const AGENT_BUILD_DEFAULT_URL = 'https://aistudio.google.com/';
const AGENT_BUILD_MAX_PROMPT_CHARS = 8000;

function createAgentBuild(req, res) {
  const body = req.body || {};
  const { prompt, url, cookies, maxMinutes, fcmToken } = body;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > AGENT_BUILD_MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: INVALID_PROMPT_BN_EN });
  }
  const targetUrl = url === undefined ? AGENT_BUILD_DEFAULT_URL : url;
  if (!isHttpUrl(targetUrl)) {
    return res.status(400).json({ error: INVALID_URL_BN_EN });
  }
  if (cookies !== undefined && !Array.isArray(cookies)) {
    return res.status(400).json({ error: INVALID_COOKIES_BN_EN });
  }
  if (maxMinutes !== undefined && (typeof maxMinutes !== 'number' || Number.isNaN(maxMinutes))) {
    return res.status(400).json({ error: INVALID_MAX_MINUTES_BN_EN });
  }
  if (fcmToken !== undefined && typeof fcmToken !== 'string') {
    return res.status(400).json({ error: INVALID_FCM_TOKEN_BN_EN });
  }
  const minutes = maxMinutes === undefined
    ? 10
    : Math.max(1, Math.min(20, Math.floor(maxMinutes)));
  const jobId = jobs.createJob('aistudio-build', {
    type: 'aistudio-build',
    prompt,
    url: targetUrl,
    cookies,
    maxMinutes: minutes,
    fcmToken: typeof fcmToken === 'string' ? fcmToken : undefined,
    // Per-job timeout: the build window plus 2 minutes of agent overhead.
    timeoutMs: minutes * 60 * 1000 + 120000,
  });
  if (!jobId) {
    return res.status(429).json({ error: TOO_MANY_JOBS_BN_EN });
  }
  const job = jobs.getJob(jobId);
  // Fire and forget: the app polls GET /api/job/:id for the result.
  jobs.runJob(job, (j, update) => runAiStudioBuild(j, update, {
    getPool,
    applyCookies,
    harvestCookies,
    applyStealth,
    takeSmallScreenshot,
    isChallengePage,
  })).catch(() => {});
  return res.status(202).json({ jobId });
}

app.post('/api/agent/build', requireAuth, createAgentBuild);

// ---------------------------------------------------------------------------
// Browser-interaction loop agent (server-side, lib/browser-agent.js).
// POST /api/agent/browse creates a long 'browser-loop' job that drives a
// general web task end-to-end: observe the page as an accessibility-tree
// snapshot -> ask the dedicated LLM for ONE action from a fixed
// vocabulary -> act -> fresh snapshot -> repeat (max 30 steps — a Nexus
// choice; Meta publishes no step cap). Same dedicated LLM keys as the
// build agent (BROWSER_AGENT_GEMINI_KEY, BROWSER_AGENT_OPENROUTER_KEY),
// never the chat agents' keys and never Groq. Same job pattern as
// /api/agent/build: no 503 when the key is unconfigured — the job
// finishes fast with status 'not-configured'.
// Guardrails (lib/guardrails.js) stop the run before a consequential
// step: bot check / injection -> 'blocked'; checkout -> 'needs-approval';
// OTP -> 'needs-user'. A high-risk form submit pauses the run with
// status 'needs-confirmation' (filled values shown for review) until
// the app answers POST /api/agent/browse/:id/confirm.
// ---------------------------------------------------------------------------
const AGENT_BROWSE_MAX_TASK_CHARS = 4000;

function createAgentBrowse(req, res) {
  const body = req.body || {};
  const { task, url, cookies, maxMinutes, fcmToken } = body;
  if (typeof task !== 'string' || !task.trim() || task.length > AGENT_BROWSE_MAX_TASK_CHARS) {
    return res.status(400).json({ error: INVALID_TASK_BN_EN });
  }
  // url is optional: when absent, the loop starts on about:blank and the
  // agent navigates — to a URL named in the task, or one it chooses.
  if (url !== undefined && !isHttpUrl(url)) {
    return res.status(400).json({ error: INVALID_URL_BN_EN });
  }
  if (cookies !== undefined && !Array.isArray(cookies)) {
    return res.status(400).json({ error: INVALID_COOKIES_BN_EN });
  }
  if (maxMinutes !== undefined && (typeof maxMinutes !== 'number' || Number.isNaN(maxMinutes))) {
    return res.status(400).json({ error: INVALID_MAX_MINUTES_BN_EN });
  }
  if (fcmToken !== undefined && typeof fcmToken !== 'string') {
    return res.status(400).json({ error: INVALID_FCM_TOKEN_BN_EN });
  }
  const minutes = maxMinutes === undefined
    ? 10
    : Math.max(1, Math.min(20, Math.floor(maxMinutes)));
  const jobId = jobs.createJob('browser-loop', {
    type: 'browser-loop',
    task,
    url,
    cookies,
    maxMinutes: minutes,
    fcmToken: typeof fcmToken === 'string' ? fcmToken : undefined,
    // Per-job timeout: the browse window plus 2 minutes of agent overhead.
    timeoutMs: minutes * 60 * 1000 + 120000,
  });
  if (!jobId) {
    return res.status(429).json({ error: TOO_MANY_JOBS_BN_EN });
  }
  const job = jobs.getJob(jobId);
  // Fire and forget: the app polls GET /api/job/:id for the result.
  jobs.runJob(job, (j, update) => runBrowserLoop(j, update, {
    getPool,
    applyCookies,
    harvestCookies,
    applyStealth,
    takeSmallScreenshot,
    isChallengePage,
  })).catch(() => {});
  return res.status(202).json({ jobId });
}

app.post('/api/agent/browse', requireAuth, createAgentBrowse);

// Confirm (or decline) a paused high-risk form submit. The loop holds
// the browser while it waits, so this only answers runs that are
// actually paused in lib/browser-agent.js's in-memory map: an unknown
// id, or an id that is not paused, is 404. confirmed=true resumes the
// run to the submit; false cancels it. The final outcome is visible by
// polling GET /api/job/:id afterwards.
function confirmAgentBrowse(req, res) {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: JOB_NOT_FOUND_BN_EN });
  if (!getPausedConfirmation(req.params.id)) {
    return res.status(404).json({ error: BROWSE_NOT_PAUSED_BN_EN });
  }
  const confirmed = (req.body || {}).confirmed;
  if (typeof confirmed !== 'boolean') {
    return res.status(400).json({ error: INVALID_CONFIRMED_BN_EN });
  }
  // The pause may have resolved (timeout / cancel) between the check
  // above and this call — then the run is no longer paused.
  const resumed = confirmBrowserLoop(req.params.id, confirmed);
  if (!resumed) return res.status(404).json({ error: BROWSE_NOT_PAUSED_BN_EN });
  return res.json({ ok: true, status: confirmed ? 'resumed' : 'cancelled' });
}

app.post('/api/agent/browse/:id/confirm', requireAuth, confirmAgentBrowse);

// STOP: cancel a running/queued/paused job. The agent checks
// job._cancelled between steps and stops; runJob() keeps the 'cancelled'
// status instead of marking the job done/failed. No push on cancel.
function cancelJobRoute(req, res) {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: JOB_NOT_FOUND_BN_EN });
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    return res.status(400).json({ error: JOB_ALREADY_TERMINAL_BN_EN });
  }
  jobs.cancelJob(req.params.id);
  return res.json({ ok: true, status: 'cancelled' });
}

app.post('/api/job/:id/cancel', requireAuth, cancelJobRoute);
app.post('/api/jobs/:id/cancel', requireAuth, cancelJobRoute);

// ---------------------------------------------------------------------------
// Push notifications (FCM via Firebase Admin SDK — lib/push.js).
// POST /api/notify { token, title, body, data? } -> { ok: true, messageId }
// Auth: same requireAuth (x-api-key) as every other /api/* endpoint.
// Returns 503 when push is not configured (no FIREBASE_SERVICE_ACCOUNT_JSON),
// 400 on invalid input. The token is never logged in full (masked only).
// ---------------------------------------------------------------------------
const MAX_NOTIFY_TITLE = 200;
const MAX_NOTIFY_BODY = 1000;

app.post('/api/notify', requireAuth, async (req, res) => {
  const body = req.body || {};
  const { token, title, body: text, data } = body;
  if (!token || typeof token !== 'string' || token.length < 10 || token.length > 4096) {
    return res.status(400).json({ ok: false, error: 'token is required (string, 10–4096 chars)' });
  }
  if (!title || typeof title !== 'string' || title.length > MAX_NOTIFY_TITLE) {
    return res.status(400).json({ ok: false, error: 'title is required (string, max ' + MAX_NOTIFY_TITLE + ' chars)' });
  }
  if (!text || typeof text !== 'string' || text.length > MAX_NOTIFY_BODY) {
    return res.status(400).json({ ok: false, error: 'body is required (string, max ' + MAX_NOTIFY_BODY + ' chars)' });
  }
  if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
    return res.status(400).json({ ok: false, error: 'data must be an object of string values' });
  }
  try {
    const messageId = await sendPush(token, { title, body: text, data });
    return res.json({ ok: true, messageId });
  } catch (err) {
    if (err && err.code === 'PUSH_NOT_CONFIGURED') {
      return res.status(503).json({ ok: false, error: err.message });
    }
    console.warn('[push] /api/notify failed for ' + maskToken(token) + ': ' + (err && err.message ? err.message : err));
    return res.status(502).json({ ok: false, error: 'failed to send push: ' + (err && err.message ? err.message : String(err)) });
  }
});

app.post('/api/screenshot', requireAuth, async (req, res) => {
  const { url, selector, clip, cookies } = req.body || {};
  if (!isHttpUrl(url)) {
    return res.status(400).json({ error: INVALID_URL_BN_EN });
  }
  try {
    const result = await withTimeout(
      runPooledScreenshot(url, { selector, clip, cookies }),
      TASK_TIMEOUT_MS,
    );
    res.json(result);
  } catch (err) {
    if (err && err.status === 429) return res.status(429).json({ error: err.message });
    if (err && err.message && err.message.indexOf('task timed out') === 0) {
      return res.status(504).json({ error: SYNC_TIMEOUT_BN_EN });
    }
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

app.post('/api/fill', requireAuth, async (req, res) => {
  const body = req.body || {};
  if (!isHttpUrl(body.url)) {
    return res.status(400).json({ error: INVALID_URL_BN_EN });
  }
  if (!Array.isArray(body.fields)) {
    return res.status(400).json({ error: INVALID_FIELDS_BN_EN });
  }
  try {
    const result = await withTimeout(
      runPooledFill(body.url, {
        fields: body.fields,
        submit: body.submit,
        allowPassword: body.allowPassword,
        checkoutApproved: body.checkoutApproved,
        cookies: body.cookies,
      }),
      TASK_TIMEOUT_MS,
    );
    res.json(result);
  } catch (err) {
    if (err && err.status === 429) return res.status(429).json({ error: err.message });
    if (err && err.message && err.message.indexOf('task timed out') === 0) {
      return res.status(504).json({ error: SYNC_TIMEOUT_BN_EN });
    }
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

// ---------------------------------------------------------------------------
// GitHub App routes
// ---------------------------------------------------------------------------

// GitHub webhook receiver — NO x-api-key auth here (GitHub cannot send it);
// the HMAC signature IS the auth. Events handled: installation
// (created / deleted / new_permissions_accepted) and
// installation_repositories (added / removed). Anything else (e.g. ping)
// is acknowledged and ignored.
app.post('/github/webhook', (req, res) => {
  if (!GITHUB_WEBHOOK_SECRET) {
    return res.status(503).json({ ok: false, error: 'GitHub webhook not configured: GITHUB_WEBHOOK_SECRET is not set' });
  }
  const event = req.header('x-github-event') || '';
  if (!verifyGitHubSignature(req)) {
    return res.status(401).json({ ok: false, error: 'bad webhook signature' });
  }
  const body = req.body || {};
  const instId = body.installation && body.installation.id != null ? String(body.installation.id) : null;

  if (event === 'installation') {
    const action = body.action || '';
    if (action === 'created' || action === 'new_permissions_accepted') {
      const rec = upsertInstallation(body, 'installation.' + action);
      recordEvent('installation.' + action, instId, rec && rec.account ? { account: rec.account.login, repositories: rec.repositories } : null);
    } else if (action === 'deleted') {
      const rec = installations.get(instId);
      if (rec) {
        rec.status = 'deleted';
        rec.updatedAt = new Date().toISOString();
        rec.lastEvent = 'installation.deleted';
      }
      recordEvent('installation.deleted', instId, rec && rec.account ? { account: rec.account.login } : null);
    } else {
      recordEvent('installation.' + action, instId, null);
    }
    saveInstallations();
    return res.json({ ok: true, event });
  }

  if (event === 'installation_repositories') {
    const rec = installations.get(instId);
    const added = repoNames(body.repositories_added);
    const removed = repoNames(body.repositories_removed);
    if (rec) {
      const set = new Set(rec.repositories);
      added.forEach((r) => set.add(r));
      removed.forEach((r) => set.delete(r));
      rec.repositories = [...set];
      rec.updatedAt = new Date().toISOString();
      rec.lastEvent = 'installation_repositories.' + (body.action || '');
    }
    recordEvent('installation_repositories.' + (body.action || ''), instId, { added, removed });
    saveInstallations();
    return res.json({ ok: true, event });
  }

  return res.json({ ok: true, ignored: true, event });
});

// Mint a short-lived installation access token for the Nexus app.
// Body: { "installationId": 12345678 } — the token is scoped to the repos
// the GitHub App is installed on and expires within ~1 hour (GitHub-set).
// The token is returned to the authenticated app only; it is never logged.
app.post('/api/github/installation-token', requireAuth, async (req, res) => {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    return res.status(503).json({ ok: false, error: 'GitHub App not configured: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY' });
  }
  const rawId = (req.body || {}).installationId;
  const installationId = typeof rawId === 'number' ? rawId : parseInt(String(rawId || ''), 10);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return res.status(400).json({ ok: false, error: 'installationId (a positive integer) is required' });
  }
  let jwt;
  try {
    jwt = buildGitHubAppJwt();
  } catch (err) {
    return res.status(503).json({ ok: false, error: 'could not sign GitHub App JWT — check GITHUB_APP_PRIVATE_KEY' });
  }
  try {
    const ghRes = await fetch('https://api.github.com/app/installations/' + installationId + '/access_tokens', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + jwt,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nexus-browser-worker',
      },
    });
    const data = await ghRes.json().catch(() => ({}));
    if (!ghRes.ok) {
      return res.status(ghRes.status).json({ ok: false, error: 'GitHub API error: ' + (data.message || ghRes.statusText) });
    }
    res.json({ ok: true, token: data.token, expiresAt: data.expires_at, installationId });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'could not reach api.github.com: ' + err.message });
  }
});

// List recorded installations + recent webhook events (auth: x-api-key).
// An empty list means "no events seen yet" — not "nothing is installed":
// the state file is ephemeral on free hosts without a volume.
app.get('/api/github/installations', requireAuth, (req, res) => {
  res.json({
    ok: true,
    installations: [...installations.values()],
    recentEvents,
    configured: Boolean(GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY && GITHUB_WEBHOOK_SECRET),
  });
});

// JSON body errors (e.g. malformed JSON) as JSON, not an HTML page.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'invalid JSON body' });
  }
  return next(err);
});

// ---------------------------------------------------------------------------
// Start + graceful shutdown
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log('nexus-browser-worker listening on port ' + PORT);
  // Agent LLM status only (configured/provider/model/chain booleans) —
  // agentLlmStatus() returns NO key, so this log is safe.
  console.log('[agent] browser agent LLM:', JSON.stringify(agentLlmStatus()));
  // Search status only (configured/quota counts) — searchStatus()
  // returns NO key, so this log is safe.
  console.log('[search] web search:', JSON.stringify(searchStatus()));
  if (!API_KEY) console.warn('WARNING: BROWSER_WORKER_KEY is not set — /api/* will return 503 until it is set.');
});

async function shutdown(signal) {
  console.log('received ' + signal + ', shutting down…');
  server.close(async () => {
    await closeBrowser();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
