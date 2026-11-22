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

const PORT = parseInt(process.env.PORT || '3000', 10);
const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || '60000', 10);
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || '5', 10);
const API_KEY = process.env.BROWSER_WORKER_KEY || '';
const STEP_TIMEOUT_DEFAULT = 15000;
const MAX_TEXT_CHARS = 20000;

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
      b.on('disconnected', () => { browser = null; });
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

async function runBrowse(url, steps) {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_DEFAULT });
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
    };
    if (screenshotBase64) out.screenshotBase64 = screenshotBase64;
    return out;
  } finally {
    await context.close().catch(() => {});
  }
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
    endpoints: ['GET /health', 'POST /api/browse', 'POST /api/read', 'POST /github/webhook', 'POST /api/github/installation-token', 'GET /api/github/installations'],
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
  const { url, steps } = req.body || {};
  const hasGoto = Array.isArray(steps) && steps.some((s) => s && s.action === 'goto');
  if (!url && !hasGoto) {
    return res.status(400).json({ ok: false, error: 'url or a goto step is required' });
  }
  if (steps !== undefined && !Array.isArray(steps)) {
    return res.status(400).json({ ok: false, error: 'steps must be an array' });
  }
  try {
    const result = await runExclusive(() => withTimeout(runBrowse(url, steps), TASK_TIMEOUT_MS));
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
