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
 */

const express = require('express');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || '60000', 10);
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || '5', 10);
const API_KEY = process.env.BROWSER_WORKER_KEY || '';
const STEP_TIMEOUT_DEFAULT = 15000;
const MAX_TEXT_CHARS = 20000;

const app = express();
app.use(express.json({ limit: '1mb' }));

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
// Routes
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'nexus-browser-worker',
    endpoints: ['GET /health', 'POST /api/browse', 'POST /api/read'],
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
