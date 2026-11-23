// Nexus browser-worker server — smoke tests for the NEW job endpoints.
// Node built-ins only (node:http + node:assert). No new npm dependencies.
//
// Assumes the server is ALREADY running (the verifier starts it with
// BROWSER_WORKER_KEY=$TEST_API_KEY). Do NOT spawn the server here.
// Cases 17-18 assume the server was started WITHOUT any
// BROWSER_AGENT_* keys, so the agent job ends 'not-configured' fast
// and never launches a real AI Studio build.
//
//   PORT=3000 TEST_API_KEY=<key> node tests/smoke.mjs
//
// Env:
//   PORT         — server port, default 3000
//   TEST_API_KEY — the key the server was started with (BROWSER_WORKER_KEY)
//
// Exit code: 0 = all cases PASS, non-zero = at least one FAIL.

import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Search (lib/search.js): cases 23-24 are in-process unit tests — no
// network, no CSE quota spent. Case 25 is the live HTTP check.
import { createQuotaTracker, parseDuckDuckGoHtml, isDuckDuckGoBlockPage, searchWeb, CSE_DAILY_LIMIT } from '../lib/search.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.TEST_API_KEY || '';
const WRONG_KEY = 'wrong-key-for-smoke-test';
const BASE = `http://127.0.0.1:${PORT}`;

if (!API_KEY) {
  console.error('FAIL: TEST_API_KEY is not set — run with TEST_API_KEY=<key> node tests/smoke.mjs');
  process.exit(2);
}

const results = [];

function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function request({ method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(
      BASE + path,
      {
        method,
        headers: {
          ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode, body: json, raw });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(65000, () => req.destroy(new Error('request timed out')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const auth = { 'x-api-key': API_KEY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll GET /api/job/:id until a terminal status, max maxMs (default 60 s), 2 s interval.
async function waitForTerminal(jobId, maxMs = 60_000) {
  const deadline = Date.now() + maxMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await request({ method: 'GET', path: `/api/job/${jobId}`, headers: auth });
    assert.equal(last.status, 200, `GET /api/job/${jobId} -> ${last.status}: ${last.raw}`);
    assert.equal(last.body.id, jobId);
    const status = last.body.status;
    assert.ok(typeof status === 'string' && status.length > 0, 'job status must be a non-empty string');
    if (status === 'done' || status === 'failed') return last;
    await sleep(2000);
  }
  assert.fail(`job ${jobId} did not reach a terminal status within ${maxMs / 1000}s (last status: ${last?.body?.status ?? 'unknown'})`);
}

async function main() {
  // (1) GET /health -> 200, no auth
  try {
    const r = await request({ method: 'GET', path: '/health' });
    assert.equal(r.status, 200, `GET /health -> ${r.status}: ${r.raw}`);
    report('1. GET /health -> 200 (no auth)', true);
  } catch (err) {
    report('1. GET /health -> 200 (no auth)', false, err.message);
  }

  // (2) POST /api/job without key -> 401
  try {
    const r = await request({
      method: 'POST', path: '/api/job',
      body: { type: 'read', url: 'https://example.com' },
    });
    assert.equal(r.status, 401, `POST /api/job without key -> ${r.status}: ${r.raw}`);
    report('2. POST /api/job without key -> 401', true);
  } catch (err) {
    report('2. POST /api/job without key -> 401', false, err.message);
  }

  // (3) POST /api/job with wrong key -> 401
  try {
    const r = await request({
      method: 'POST', path: '/api/job',
      headers: { 'x-api-key': WRONG_KEY },
      body: { type: 'read', url: 'https://example.com' },
    });
    assert.equal(r.status, 401, `POST /api/job with wrong key -> ${r.status}: ${r.raw}`);
    report('3. POST /api/job with wrong key -> 401', true);
  } catch (err) {
    report('3. POST /api/job with wrong key -> 401', false, err.message);
  }

  // (4) POST /api/job {type:"read", url:"https://example.com"} with key -> 202 {jobId}
  let jobId;
  try {
    const r = await request({
      method: 'POST', path: '/api/job',
      headers: auth,
      body: { type: 'read', url: 'https://example.com' },
    });
    assert.equal(r.status, 202, `POST /api/job -> ${r.status}: ${r.raw}`);
    assert.ok(r.body && typeof r.body.jobId === 'string' && r.body.jobId.length > 0,
      `expected {jobId} in response, got: ${r.raw}`);
    jobId = r.body.jobId;
    report('4. POST /api/job read -> 202 with jobId', true, `jobId=${jobId}`);
  } catch (err) {
    report('4. POST /api/job read -> 202 with jobId', false, err.message);
  }

  // (5) Poll GET /api/job/:id until done/failed (max 60s)
  try {
    const r = await waitForTerminal(jobId);
    const status = r.body.status;
    assert.ok(status === 'done' || status === 'failed', `terminal status must be done/failed, got: ${status}`);
    assert.ok('progress' in r.body, 'job must include progress');
    assert.ok(Array.isArray(r.body.steps), 'job must include steps array');
    if (status === 'failed') {
      report('5. GET /api/job/:id -> terminal status', true, `status=failed (error: ${r.body.error ?? 'n/a'})`);
    } else {
      report('5. GET /api/job/:id -> terminal status', true, `status=done`);
    }
  } catch (err) {
    report('5. GET /api/job/:id -> terminal status', false, err.message);
  }

  // (6) POST /api/screenshot {url:"https://example.com"} -> 200, JPEG, < 150000 bytes
  try {
    const r = await request({
      method: 'POST', path: '/api/screenshot',
      headers: auth,
      body: { url: 'https://example.com' },
    });
    assert.equal(r.status, 200, `POST /api/screenshot -> ${r.status}: ${r.raw}`);
    assert.ok(typeof r.body.jpegBase64 === 'string' && r.body.jpegBase64.startsWith('/9j/'),
      'jpegBase64 must be a JPEG data string starting with "/9j/"');
    assert.ok(typeof r.body.width === 'number' && r.body.width > 0, 'width must be a positive number');
    assert.ok(typeof r.body.height === 'number' && r.body.height > 0, 'height must be a positive number');
    assert.ok(typeof r.body.bytes === 'number' && r.body.bytes > 0, 'bytes must be a positive number');
    assert.ok(r.body.bytes < 150000, `bytes must be < 150000, got ${r.body.bytes}`);
    report('6. POST /api/screenshot -> 200, JPEG < 150000 bytes', true, `${r.body.width}x${r.body.height}, ${r.body.bytes} bytes`);
  } catch (err) {
    report('6. POST /api/screenshot -> 200, JPEG < 150000 bytes', false, err.message);
  }

  // (7) POST /api/fill with a nonexistent field -> 200, filledCount 0, notFound length 1
  try {
    const r = await request({
      method: 'POST', path: '/api/fill',
      headers: auth,
      body: { url: 'https://example.com', fields: [{ name: 'nonexistent', value: 'x' }] },
    });
    assert.equal(r.status, 200, `POST /api/fill -> ${r.status}: ${r.raw}`);
    assert.equal(r.body.filledCount, 0, `filledCount must be 0, got: ${r.raw}`);
    assert.ok(Array.isArray(r.body.notFound) && r.body.notFound.length === 1,
      `notFound must have length 1, got: ${r.raw}`);
    assert.ok(typeof r.body.url === 'string' && r.body.url.length > 0, 'url must be returned');
    report('7. POST /api/fill nonexistent field -> 200, filledCount 0, notFound length 1', true);
  } catch (err) {
    report('7. POST /api/fill nonexistent field -> 200, filledCount 0, notFound length 1', false, err.message);
  }

  // (8) POST /api/screenshot without key -> 401
  try {
    const r = await request({
      method: 'POST', path: '/api/screenshot',
      body: { url: 'https://example.com' },
    });
    assert.equal(r.status, 401, `POST /api/screenshot without key -> ${r.status}: ${r.raw}`);
    report('8. POST /api/screenshot without key -> 401', true);
  } catch (err) {
    report('8. POST /api/screenshot without key -> 401', false, err.message);
  }

  // (9) Regression: {"task":"ping"} to /api/browse -> 200 pong, no browser launch
  try {
    const r = await request({
      method: 'POST', path: '/api/browse',
      headers: auth,
      body: { task: 'ping' },
    });
    assert.equal(r.status, 200, `POST /api/browse ping -> ${r.status}: ${r.raw}`);
    assert.equal(r.body.result, 'pong', `ping result must be 'pong', got: ${r.raw}`);
    assert.equal(r.body.text, 'pong', `ping text must be 'pong', got: ${r.raw}`);
    report('9. POST /api/browse {"task":"ping"} -> 200 pong', true);
  } catch (err) {
    report('9. POST /api/browse {"task":"ping"} -> 200 pong', false, err.message);
  }

  // (10) POST /api/browse with non-array cookies -> 400 'cookies must be an array'
  try {
    const r = await request({
      method: 'POST', path: '/api/browse',
      headers: auth,
      body: { url: 'https://example.com', cookies: 'not-an-array' },
    });
    assert.equal(r.status, 400, `POST /api/browse cookies=string -> ${r.status}: ${r.raw}`);
    assert.ok(typeof r.body.error === 'string' && r.body.error.includes('cookies must be an array'),
      `error must say 'cookies must be an array', got: ${r.raw}`);
    report('10. POST /api/browse cookies non-array -> 400', true);
  } catch (err) {
    report('10. POST /api/browse cookies non-array -> 400', false, err.message);
  }

  // (11) POST /api/browse with a valid cookies array -> 200 + cookies returned.
  // Uses about:blank so no network is needed: this proves applyCookies accepts
  // the app's {name, value, domain} shape (no path — sessions.js defaults it
  // to '/') and the response carries the harvested cookies back.
  try {
    const r = await request({
      method: 'POST', path: '/api/browse',
      headers: auth,
      body: {
        url: 'about:blank',
        cookies: [{ name: 'SID', value: 'smoke-test-value', domain: '.example.com' }],
      },
    });
    assert.equal(r.status, 200, `POST /api/browse cookies=array -> ${r.status}: ${r.raw}`);
    assert.ok(Array.isArray(r.body.cookies), `200 response must carry a cookies array, got: ${r.raw}`);
    assert.ok(r.body.cookies.some((c) => c.name === 'SID'), `harvested cookies must include SID, got: ${r.raw}`);
    report('11. POST /api/browse cookies array -> 200, cookies returned', true, `${r.body.cookies.length} cookies`);
  } catch (err) {
    report('11. POST /api/browse cookies array -> 200, cookies returned', false, err.message);
  }

  // (12) POST /api/agent/build missing prompt -> 400
  try {
    const r = await request({
      method: 'POST', path: '/api/agent/build',
      headers: auth,
      body: {},
    });
    assert.equal(r.status, 400, `POST /api/agent/build no prompt -> ${r.status}: ${r.raw}`);
    assert.ok(typeof r.body.error === 'string' && r.body.error.toLowerCase().includes('prompt'),
      `error must mention prompt, got: ${r.raw}`);
    report('12. POST /api/agent/build missing prompt -> 400', true);
  } catch (err) {
    report('12. POST /api/agent/build missing prompt -> 400', false, err.message);
  }

  // (13) POST /api/agent/build empty prompt -> 400
  try {
    const r = await request({
      method: 'POST', path: '/api/agent/build',
      headers: auth,
      body: { prompt: '   ' },
    });
    assert.equal(r.status, 400, `POST /api/agent/build empty prompt -> ${r.status}: ${r.raw}`);
    report('13. POST /api/agent/build empty prompt -> 400', true);
  } catch (err) {
    report('13. POST /api/agent/build empty prompt -> 400', false, err.message);
  }

  // (14) POST /api/agent/build prompt over 8000 chars -> 400
  try {
    const r = await request({
      method: 'POST', path: '/api/agent/build',
      headers: auth,
      body: { prompt: 'x'.repeat(8001) },
    });
    assert.equal(r.status, 400, `POST /api/agent/build 8001-char prompt -> ${r.status}: ${r.raw}`);
    report('14. POST /api/agent/build prompt > 8000 chars -> 400', true);
  } catch (err) {
    report('14. POST /api/agent/build prompt > 8000 chars -> 400', false, err.message);
  }

  // (15) POST /api/agent/build bad url -> 400
  try {
    const r = await request({
      method: 'POST', path: '/api/agent/build',
      headers: auth,
      body: { prompt: 'build a tiny test app', url: 'not-a-url' },
    });
    assert.equal(r.status, 400, `POST /api/agent/build bad url -> ${r.status}: ${r.raw}`);
    assert.ok(typeof r.body.error === 'string' && r.body.error.includes('Invalid URL'),
      `error must say 'Invalid URL', got: ${r.raw}`);
    report('15. POST /api/agent/build bad url -> 400', true);
  } catch (err) {
    report('15. POST /api/agent/build bad url -> 400', false, err.message);
  }

  // (16) POST /api/agent/build maxMinutes non-number -> 400
  try {
    const r = await request({
      method: 'POST', path: '/api/agent/build',
      headers: auth,
      body: { prompt: 'build a tiny test app', maxMinutes: 'ten' },
    });
    assert.equal(r.status, 400, `POST /api/agent/build maxMinutes=string -> ${r.status}: ${r.raw}`);
    assert.ok(typeof r.body.error === 'string' && r.body.error.includes('maxMinutes must be a number'),
      `error must say 'maxMinutes must be a number', got: ${r.raw}`);
    report('16. POST /api/agent/build maxMinutes non-number -> 400', true);
  } catch (err) {
    report('16. POST /api/agent/build maxMinutes non-number -> 400', false, err.message);
  }

  // (17) POST /api/agent/build maxMinutes out of range is clamped, not rejected.
  // server.js: Math.max(1, Math.min(20, Math.floor(maxMinutes))) — so 0 and
  // 999 must both be accepted with 202. The clamp itself is not visible via
  // the public API (params are stripped from publicJob), so acceptance is
  // the observable behaviour. The first job (maxMinutes 0) is reused for
  // cases 18 and 20.
  let agentJobId = null;
  try {
    for (const mm of [0, 999]) {
      const r = await request({
        method: 'POST', path: '/api/agent/build',
        headers: auth,
        body: { prompt: 'build a tiny test app', maxMinutes: mm },
      });
      assert.equal(r.status, 202, `POST /api/agent/build maxMinutes=${mm} -> ${r.status}: ${r.raw}`);
      assert.ok(r.body && typeof r.body.jobId === 'string' && r.body.jobId.length > 0,
        `expected {jobId} in response, got: ${r.raw}`);
      if (mm === 0) agentJobId = r.body.jobId;
    }
    report('17. POST /api/agent/build maxMinutes 0 and 999 -> 202 (clamped, not rejected)', true, `jobId=${agentJobId}`);
  } catch (err) {
    report('17. POST /api/agent/build maxMinutes 0 and 999 -> 202 (clamped, not rejected)', false, err.message);
  }

  // (18) Agent job with NO agent keys configured -> done, result 'not-configured'.
  // lib/aistudio-agent.js gates on anyLegConfigured() BEFORE launching any
  // browser, so no real AI Studio build is started. Requires the server to
  // have been started without BROWSER_AGENT_* keys (see header comment).
  let agentJobTerminal = false;
  try {
    assert.ok(agentJobId, 'no agent jobId from case 17');
    const r = await waitForTerminal(agentJobId, 30_000);
    assert.equal(r.body.status, 'done', `agent job status must be 'done', got: ${r.raw}`);
    assert.ok(r.body.result && r.body.result.status === 'not-configured',
      `result.status must be 'not-configured', got: ${r.raw}`);
    const errText = (r.body.result && r.body.result.error) || '';
    assert.ok(/not configured/i.test(errText),
      `result.error must mention the agent LLM is not configured, got: ${errText}`);
    assert.ok(errText.includes('BROWSER_AGENT_GEMINI_KEY'),
      `result.error must name BROWSER_AGENT_GEMINI_KEY, got: ${errText}`);
    agentJobTerminal = true;
    report('18. Agent job, no agent keys -> done / not-configured (no browser launched)', true, errText.slice(0, 80));
  } catch (err) {
    report('18. Agent job, no agent keys -> done / not-configured (no browser launched)', false, err.message);
  }

  // (19) POST /api/job/:id/cancel unknown id -> 404
  try {
    const r = await request({
      method: 'POST', path: '/api/job/00000000-0000-0000-0000-000000000000/cancel',
      headers: auth,
      body: {},
    });
    assert.equal(r.status, 404, `POST /api/job/:id/cancel unknown -> ${r.status}: ${r.raw}`);
    report('19. POST /api/job/:id/cancel unknown id -> 404', true);
  } catch (err) {
    report('19. POST /api/job/:id/cancel unknown id -> 404', false, err.message);
  }

  // (20) POST /api/job/:id/cancel of a terminal job -> 400.
  // Reuses the agent job from case 18, which is 'done' (terminal).
  try {
    assert.ok(agentJobId, 'no agent jobId from case 17');
    assert.ok(agentJobTerminal, 'agent job from case 18 did not reach a terminal status');
    const r = await request({
      method: 'POST', path: `/api/job/${agentJobId}/cancel`,
      headers: auth,
      body: {},
    });
    assert.equal(r.status, 400, `POST /api/job/:id/cancel terminal job -> ${r.status}: ${r.raw}`);
    assert.ok(typeof r.body.error === 'string' && r.body.error.includes('already finished'),
      `error must say the job is already finished, got: ${r.raw}`);
    report('20. POST /api/job/:id/cancel terminal job -> 400', true);
  } catch (err) {
    report('20. POST /api/job/:id/cancel terminal job -> 400', false, err.message);
  }

  // (21) POST /api/search without key -> 401
  try {
    const r = await request({
      method: 'POST', path: '/api/search',
      body: { q: 'dhaka weather' },
    });
    assert.equal(r.status, 401, `POST /api/search without key -> ${r.status}: ${r.raw}`);
    report('21. POST /api/search without key -> 401', true);
  } catch (err) {
    report('21. POST /api/search without key -> 401', false, err.message);
  }

  // (22) POST /api/search with a bad q -> 400 (missing, empty, non-string)
  try {
    for (const bad of [{}, { q: '' }, { q: '   ' }, { q: 123 }, { q: 'x'.repeat(501) }]) {
      const r = await request({
        method: 'POST', path: '/api/search',
        headers: auth,
        body: bad,
      });
      assert.equal(r.status, 400, `POST /api/search q=${JSON.stringify(bad).slice(0, 30)} -> ${r.status}: ${r.raw}`);
    }
    report('22. POST /api/search bad q (missing/empty/non-string/too long) -> 400', true);
  } catch (err) {
    report('22. POST /api/search bad q (missing/empty/non-string/too long) -> 400', false, err.message);
  }

  // (23) In-process: parseDuckDuckGoHtml decodes DDG's uddg-wrapped
  // links, strips tags/entities, and zips snippets by position.
  try {
    const canned = `
<div class="result results_links results_links_deep web-result">
<div class="links_main links_deep result__body">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdhaka&amp;rut=abc">Dhaka Weather &amp; Forecast</a></h2>
<a class="result__snippet" href="https://example.com/dhaka">Today in Dhaka: 28C, light rain and humidity.</a>
</div></div>
<div class="result results_links results_links_deep web-result">
<div class="links_main links_deep result__body">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.org/bangladesh">Bangladesh News</a></h2>
<a class="result__snippet" href="https://example.org/bangladesh">Latest headlines from Bangladesh.</a>
</div></div>`;
    const parsed = parseDuckDuckGoHtml(canned);
    assert.equal(parsed.length, 2, `expected 2 results, got: ${JSON.stringify(parsed)}`);
    assert.equal(parsed[0].url, 'https://example.com/dhaka', `uddg must decode, got: ${parsed[0].url}`);
    assert.equal(parsed[0].title, 'Dhaka Weather & Forecast', `title entities must decode, got: ${parsed[0].title}`);
    assert.equal(parsed[0].snippet, 'Today in Dhaka: 28C, light rain and humidity.');
    assert.equal(parsed[1].url, 'https://example.org/bangladesh');
    assert.equal(parsed[1].snippet, 'Latest headlines from Bangladesh.');
    assert.equal(parseDuckDuckGoHtml('<html><body>no results here</body></html>').length, 0);
    report('23. parseDuckDuckGoHtml decodes uddg links + titles + snippets', true);
  } catch (err) {
    report('23. parseDuckDuckGoHtml decodes uddg links + titles + snippets', false, err.message);
  }

  // (24) In-process: the CSE quota tracker blocks the 101st call and
  // resets at midnight UTC. No real quota is spent (temp state file).
  try {
    assert.equal(CSE_DAILY_LIMIT, 100, `CSE_DAILY_LIMIT must be 100, got: ${CSE_DAILY_LIMIT}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-quota-'));
    const stateFile = path.join(dir, 'search-quota.json');
    const tracker = createQuotaTracker(stateFile);
    assert.equal(tracker.remaining(), 100, `fresh tracker must have 100 left, got: ${tracker.remaining()}`);
    assert.equal(tracker.canUse(), true);
    for (let i = 0; i < 100; i += 1) tracker.recordUse();
    assert.equal(tracker.usedToday(), 100);
    assert.equal(tracker.remaining(), 0, `after 100 uses, remaining must be 0, got: ${tracker.remaining()}`);
    assert.equal(tracker.canUse(), false, 'the 101st CSE call must be blocked');
    // A fresh tracker on the same file reads the persisted count back.
    const tracker2 = createQuotaTracker(stateFile);
    assert.equal(tracker2.remaining(), 0, 'persisted state must survive a restart');
    // Yesterday's state resets to a full 100.
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    fs.writeFileSync(stateFile, JSON.stringify({ date: yesterday, used: 100 }));
    const tracker3 = createQuotaTracker(stateFile);
    assert.equal(tracker3.remaining(), 100, `new UTC day must reset to 100, got: ${tracker3.remaining()}`);
    fs.rmSync(dir, { recursive: true, force: true });
    report('24. CSE quota tracker: 100/day, 101st blocked, midnight UTC reset', true);
  } catch (err) {
    report('24. CSE quota tracker: 100/day, 101st blocked, midnight UTC reset', false, err.message);
  }

  // (25) Live HTTP: POST /api/search with CSE unconfigured -> DuckDuckGo.
  // The sandbox may block outbound network to DDG: then the server
  // answers 502 (both providers unreachable) and the case still passes
  // with a note — the real DDG path is verified on Railway/Render
  // after deploy, where outbound network works.
  try {
    const r = await request({
      method: 'POST', path: '/api/search',
      headers: auth,
      body: { q: 'dhaka weather' },
    });
    if (r.status === 200) {
      assert.equal(r.body.provider, 'duckduckgo', `CSE unconfigured, provider must be duckduckgo, got: ${r.raw}`);
      assert.ok(Array.isArray(r.body.results), `results must be an array, got: ${r.raw}`);
      assert.equal(r.body.quotaRemaining, null, `quotaRemaining must be null when CSE is unconfigured, got: ${r.raw}`);
      report('25. POST /api/search (CSE unconfigured) -> 200, provider duckduckgo', true, `${r.body.results.length} results`);
    } else {
      assert.equal(r.status, 502, `POST /api/search -> ${r.status}: ${r.raw}`);
      assert.ok(typeof r.body.error === 'string' && /Search failed|খোঁজা যায়নি/.test(r.body.error),
        `502 error must explain the search failure, got: ${r.raw}`);
      report('25. POST /api/search (CSE unconfigured) -> 502, DDG unreachable from sandbox', true, 'live DDG path needs Railway/Render');
    }
  } catch (err) {
    report('25. POST /api/search (CSE unconfigured) -> 200 duckduckgo or 502', false, err.message);
  }

  // (26) In-process: the DDG bot-check page is detected, and a 202 on
  // the first attempt is retried once (stub fetch — no network, no quota).
  try {
    const blockPage = '<html><head><title>\n        DuckDuckGo\n    </title></head><body>no results</body></html>';
    const goodPage = '<a rel="nofollow" class="result__a" href="https://example.com/a">Alpha</a><a class="result__snippet" href="https://example.com/a">Alpha snippet.</a><a rel="nofollow" class="result__a" href="https://example.com/b">Beta</a><a class="result__snippet" href="https://example.com/b">Beta snippet.</a>';
    const normalNoResults = '<html><head><title>zxqvjk at DuckDuckGo</title></head><body>no results found</body></html>';
    assert.equal(isDuckDuckGoBlockPage(blockPage), true, 'bare-title page with no links must be a block page');
    assert.equal(isDuckDuckGoBlockPage(normalNoResults), false, 'a genuine no-results page must NOT be a block page');
    assert.equal(isDuckDuckGoBlockPage(goodPage), false, 'a results page must NOT be a block page');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-retry-'));
    const tracker = createQuotaTracker(path.join(dir, 'search-quota.json'));
    let calls = 0;
    const flakyFetch = async () => {
      calls += 1;
      if (calls === 1) return { status: 202, text: async () => blockPage };
      return { status: 200, text: async () => goodPage };
    };
    const r1 = await searchWeb('test query', { tracker, fetchImpl: flakyFetch });
    assert.equal(calls, 2, `202 must be retried once (calls=${calls})`);
    assert.equal(r1.provider, 'duckduckgo');
    assert.equal(r1.results.length, 2, `expected 2 results after retry, got: ${JSON.stringify(r1.results)}`);
    const alwaysBlocked = async () => ({ status: 202, text: async () => blockPage });
    await assert.rejects(searchWeb('test query', { tracker, fetchImpl: alwaysBlocked }), /blocked|HTTP 202/);
    fs.rmSync(dir, { recursive: true, force: true });
    report('26. DDG bot-check detected; 202 retried once, persistent block throws', true);
  } catch (err) {
    report('26. DDG bot-check detected; 202 retried once, persistent block throws', false, err.message);
  }
}

try {
  await main();
} catch (err) {
  const failedCase = results.length + 1;
  report(`case ${failedCase}`, false, err.message);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} cases passed`);
process.exit(failed === 0 ? 0 : 1);
