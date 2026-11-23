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
// Search (lib/search.js): cases 23-24 and 26-31 are in-process unit
// tests — no network, no CSE quota spent. Case 25 is the live HTTP check.
// Cases 32-43 are in-process unit tests for the free-provider chain
// (Tavily -> Exa -> Firecrawl -> Marginalia -> SearXNG -> Mojeek ->
// Bing RSS -> Brave -> CSE -> DuckDuckGo -> Wikipedia) — stub fetchImpl,
// no network, no keys spent.
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

  // (25) Live HTTP: POST /api/search with CSE unconfigured -> the
  // first working leg of the 11-leg chain answers (in the sandbox
  // that is usually a no-key leg such as Marginalia/Mojeek/Bing, or
  // 502 when the sandbox blocks outbound network entirely). The real
  // full-chain behaviour is verified on Railway/Render after deploy,
  // where outbound network works.
  try {
    const r = await request({
      method: 'POST', path: '/api/search',
      headers: auth,
      body: { q: 'dhaka weather' },
    });
    if (r.status === 200) {
      const knownProviders = ['tavily', 'exa', 'firecrawl', 'marginalia', 'searxng', 'mojeek', 'bing', 'brave', 'google', 'duckduckgo', 'wikipedia'];
      assert.ok(knownProviders.includes(r.body.provider), `provider must be a known chain leg, got: ${r.raw}`);
      assert.ok(Array.isArray(r.body.results), `results must be an array, got: ${r.raw}`);
      if (r.body.provider !== 'google') {
        assert.equal(r.body.quotaRemaining, null, `quotaRemaining must be null for non-Google providers, got: ${r.raw}`);
      }
      report('25. POST /api/search (CSE unconfigured) -> 200, first working chain leg answers', true, `${r.body.provider}: ${r.body.results.length} results`);
    } else {
      assert.equal(r.status, 502, `POST /api/search -> ${r.status}: ${r.raw}`);
      assert.ok(typeof r.body.error === 'string' && /Search failed|খোঁজা যায়নি/.test(r.body.error),
        `502 error must explain the search failure, got: ${r.raw}`);
      report('25. POST /api/search (CSE unconfigured) -> 502, no chain leg reachable from sandbox', true, 'live chain needs Railway/Render');
    }
  } catch (err) {
    report('25. POST /api/search (CSE unconfigured) -> 200 from a chain leg or 502', false, err.message);
  }

  // (26) In-process: the DDG bot-check page is detected, and a 202 on
  // the first DDG attempt is retried once (stub fetch — no network, no
  // quota). The stub routes by host: only the DuckDuckGo host gets the
  // 202-then-200 sequence; the earlier no-key legs (Marginalia, Mojeek,
  // Bing) get empty answers so they fall through without consuming the
  // DDG retry. Counts are per-host, so the DDG leg itself must show
  // exactly 2 calls.
  try {
    const blockPage = '<html><head><title>\n        DuckDuckGo\n    </title></head><body>no results</body></html>';
    const goodPage = '<a rel="nofollow" class="result__a" href="https://example.com/a">Alpha</a><a class="result__snippet" href="https://example.com/a">Alpha snippet.</a><a rel="nofollow" class="result__a" href="https://example.com/b">Beta</a><a class="result__snippet" href="https://example.com/b">Beta snippet.</a>';
    const normalNoResults = '<html><head><title>zxqvjk at DuckDuckGo</title></head><body>no results found</body></html>';
    assert.equal(isDuckDuckGoBlockPage(blockPage), true, 'bare-title page with no links must be a block page');
    assert.equal(isDuckDuckGoBlockPage(normalNoResults), false, 'a genuine no-results page must NOT be a block page');
    assert.equal(isDuckDuckGoBlockPage(goodPage), false, 'a results page must NOT be a block page');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cse-retry-'));
    const tracker = createQuotaTracker(path.join(dir, 'search-quota.json'));
    let ddgCalls = 0;
    const emptyJson = { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '{"results":[]}' };
    const emptyPage = { ok: true, status: 200, json: async () => ({}), text: async () => '<html></html>' };
    const flakyFetch = async (url) => {
      const u = String(url);
      if (u.includes('html.duckduckgo.com')) {
        ddgCalls += 1;
        if (ddgCalls === 1) return { status: 202, text: async () => blockPage };
        return { status: 200, text: async () => goodPage };
      }
      return u.includes('api2.marginalia-search.com') ? emptyJson : emptyPage;
    };
    const r1 = await searchWeb('test query', { tracker, fetchImpl: flakyFetch });
    assert.equal(ddgCalls, 2, `202 must be retried once by the DDG leg (ddg calls=${ddgCalls})`);
    assert.equal(r1.provider, 'duckduckgo');
    assert.equal(r1.results.length, 2, `expected 2 results after retry, got: ${JSON.stringify(r1.results)}`);
    const alwaysBlocked = async () => ({ status: 202, text: async () => blockPage });
    await assert.rejects(searchWeb('test query', { tracker, fetchImpl: alwaysBlocked }), /blocked|HTTP 202/);
    fs.rmSync(dir, { recursive: true, force: true });
    report('26. DDG bot-check detected; 202 retried once, persistent block throws', true);
  } catch (err) {
    report('26. DDG bot-check detected; 202 retried once, persistent block throws', false, err.message);
  }

  // (27-31) In-process Brave Search cases — stub fetchImpl, no network.
  // Agreed contract with lib/search.js (Worker A): searchWeb(query,
  // { tracker, fetchImpl }) passes fetchImpl to BOTH the Brave leg and
  // the DuckDuckGo leg, so one stub serves both by dispatching on the
  // URL (Brave URLs contain 'api.search.brave.com'). The Brave leg
  // reads BRAVE_SEARCH_API_KEY from process.env at call time; when it
  // is unset Brave is skipped and DuckDuckGo answers. CSE keys are
  // cleared around these cases too, so they stay hermetic whichever
  // order Worker A tries CSE vs Brave in.
  const ddgGoodPage = '<a rel="nofollow" class="result__a" href="https://example.com/a">Alpha</a><a class="result__snippet" href="https://example.com/a">Alpha snippet.</a><a rel="nofollow" class="result__a" href="https://example.com/b">Beta</a><a class="result__snippet" href="https://example.com/b">Beta snippet.</a>';
  // Fetch-like Brave response: Worker A may read .ok/.status and either
  // .json() or .text(), so the stub provides all four.
  const braveResponse = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });
  const ddgResponse = (html) => ({ ok: true, status: 200, text: async () => html, json: async () => ({}) });
  // Dispatching stub: routes by host. The no-key legs ahead of Brave
  // (Marginalia, Mojeek, Bing) get empty answers so they fall through
  // without being counted as DuckDuckGo calls; only
  // html.duckduckgo.com counts as a DDG call. Every stub response
  // carries both .json() and .text() since legs read either.
  const emptyJsonResponse = { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '{"results":[]}' };
  const emptyPageResponse = { ok: true, status: 200, json: async () => ({}), text: async () => '<html></html>' };
  const emptyRssResponse = { ok: true, status: 200, json: async () => ({}), text: async () => '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>' };
  const makeSearchStub = (braveImpl, counts) => async (url) => {
    const u = String(url);
    if (u.includes('api.search.brave.com')) {
      counts.brave += 1;
      return braveImpl(counts.brave);
    }
    if (u.includes('api2.marginalia-search.com')) return emptyJsonResponse;
    if (u.includes('www.mojeek.com')) return emptyPageResponse;
    if (u.includes('www.bing.com')) return emptyRssResponse;
    if (u.includes('en.wikipedia.org')) return { ok: true, status: 200, json: async () => ({ query: { search: [] } }), text: async () => '{}' };
    if (u.includes('html.duckduckgo.com')) {
      counts.ddg += 1;
      return ddgResponse(ddgGoodPage);
    }
    throw new Error('makeSearchStub: unexpected URL ' + u);
  };
  // Apply env overrides (undefined value = delete the var) and return a
  // restore function. Always used with try/finally so no case leaks env
  // into the cases after it.
  const withSearchEnv = (overrides) => {
    const prev = {
      BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
      GOOGLE_CSE_API_KEY: process.env.GOOGLE_CSE_API_KEY,
      GOOGLE_CSE_CX: process.env.GOOGLE_CSE_CX,
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return () => {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  };
  const braveTestTracker = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brave-search-'));
    return { dir, tracker: createQuotaTracker(path.join(dir, 'search-quota.json')) };
  };

  // (27) In-process: no BRAVE_SEARCH_API_KEY -> Brave is skipped
  // entirely (never called) and the DuckDuckGo stub answers.
  try {
    const { dir, tracker } = braveTestTracker();
    const restoreEnv = withSearchEnv({
      BRAVE_SEARCH_API_KEY: undefined,
      GOOGLE_CSE_API_KEY: undefined,
      GOOGLE_CSE_CX: undefined,
    });
    try {
      const counts = { brave: 0, ddg: 0 };
      const fetchStub = makeSearchStub(() => braveResponse(200, { web: { results: [] } }), counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.brave, 0, `Brave must not be called without a key (brave calls=${counts.brave})`);
      assert.equal(counts.ddg, 1, `DuckDuckGo must answer once (ddg calls=${counts.ddg})`);
      assert.equal(r.provider, 'duckduckgo');
      assert.equal(r.results.length, 2, `expected 2 DDG results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Alpha');
      assert.equal(r.quotaRemaining, null, `quotaRemaining must be null, got: ${r.quotaRemaining}`);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('27. No BRAVE_SEARCH_API_KEY -> Brave skipped, DuckDuckGo answers', true);
  } catch (err) {
    report('27. No BRAVE_SEARCH_API_KEY -> Brave skipped, DuckDuckGo answers', false, err.message);
  }

  // (28) In-process: BRAVE key set + Brave 200 JSON -> provider brave,
  // description mapped to snippet, quotaRemaining null, DDG never called.
  try {
    const { dir, tracker } = braveTestTracker();
    const restoreEnv = withSearchEnv({
      BRAVE_SEARCH_API_KEY: 'test-brave-key',
      GOOGLE_CSE_API_KEY: undefined,
      GOOGLE_CSE_CX: undefined,
    });
    try {
      const bravePayload = { web: { results: [
        { title: 'Brave Alpha', url: 'https://example.com/brave-a', description: 'Brave alpha snippet.' },
        { title: 'Brave Beta', url: 'https://example.com/brave-b', description: 'Brave beta snippet.' },
      ] } };
      const counts = { brave: 0, ddg: 0 };
      const fetchStub = makeSearchStub(() => braveResponse(200, bravePayload), counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.brave, 1, `Brave must be called once (brave calls=${counts.brave})`);
      assert.equal(counts.ddg, 0, `DuckDuckGo must not be called when Brave succeeds (ddg calls=${counts.ddg})`);
      assert.equal(r.provider, 'brave');
      assert.equal(r.results.length, 2, `expected 2 Brave results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Brave Alpha');
      assert.equal(r.results[0].url, 'https://example.com/brave-a');
      assert.equal(r.results[0].snippet, 'Brave alpha snippet.', 'description must become snippet');
      assert.equal(r.results[1].title, 'Brave Beta');
      assert.equal(r.results[1].snippet, 'Brave beta snippet.');
      assert.equal(r.quotaRemaining, null, `quotaRemaining must be null for Brave, got: ${r.quotaRemaining}`);
      assert.equal(tracker.remaining(), 100, 'Brave must not spend CSE quota');
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('28. BRAVE key + Brave 200 JSON -> provider brave, description -> snippet', true);
  } catch (err) {
    report('28. BRAVE key + Brave 200 JSON -> provider brave, description -> snippet', false, err.message);
  }

  // (29) In-process: Brave 401 -> falls through to the DuckDuckGo stub.
  try {
    const { dir, tracker } = braveTestTracker();
    const restoreEnv = withSearchEnv({
      BRAVE_SEARCH_API_KEY: 'test-brave-key',
      GOOGLE_CSE_API_KEY: undefined,
      GOOGLE_CSE_CX: undefined,
    });
    try {
      const counts = { brave: 0, ddg: 0 };
      const fetchStub = makeSearchStub(() => braveResponse(401, { message: 'Unauthorized' }), counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.ok(counts.brave >= 1, `Brave must be attempted (brave calls=${counts.brave})`);
      assert.equal(counts.ddg, 1, `DuckDuckGo must answer the fallback once (ddg calls=${counts.ddg})`);
      assert.equal(r.provider, 'duckduckgo');
      assert.equal(r.results.length, 2, `expected 2 DDG results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Alpha');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('29. Brave 401 -> falls through to DuckDuckGo', true);
  } catch (err) {
    report('29. Brave 401 -> falls through to DuckDuckGo', false, err.message);
  }

  // (30) In-process: Brave 200 with empty web.results -> falls through
  // to the DuckDuckGo stub (empty is not a successful answer).
  try {
    const { dir, tracker } = braveTestTracker();
    const restoreEnv = withSearchEnv({
      BRAVE_SEARCH_API_KEY: 'test-brave-key',
      GOOGLE_CSE_API_KEY: undefined,
      GOOGLE_CSE_CX: undefined,
    });
    try {
      const counts = { brave: 0, ddg: 0 };
      const fetchStub = makeSearchStub(() => braveResponse(200, { web: { results: [] } }), counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.ok(counts.brave >= 1, `Brave must be attempted (brave calls=${counts.brave})`);
      assert.equal(counts.ddg, 1, `DuckDuckGo must answer the fallback once (ddg calls=${counts.ddg})`);
      assert.equal(r.provider, 'duckduckgo');
      assert.equal(r.results.length, 2, `expected 2 DDG results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('30. Brave 200 with empty results -> falls through to DuckDuckGo', true);
  } catch (err) {
    report('30. Brave 200 with empty results -> falls through to DuckDuckGo', false, err.message);
  }

  // (31) In-process: Brave 500 on the first attempt, 200 on the retry
  // -> provider brave (retry-once, no fall-through to DuckDuckGo).
  try {
    const { dir, tracker } = braveTestTracker();
    const restoreEnv = withSearchEnv({
      BRAVE_SEARCH_API_KEY: 'test-brave-key',
      GOOGLE_CSE_API_KEY: undefined,
      GOOGLE_CSE_CX: undefined,
    });
    try {
      const bravePayload = { web: { results: [
        { title: 'Brave Alpha', url: 'https://example.com/brave-a', description: 'Brave alpha snippet.' },
      ] } };
      const counts = { brave: 0, ddg: 0 };
      const fetchStub = makeSearchStub(
        (call) => (call === 1
          ? braveResponse(500, { message: 'Internal Server Error' })
          : braveResponse(200, bravePayload)),
        counts,
      );
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.brave, 2, `Brave 500 must be retried once (brave calls=${counts.brave})`);
      assert.equal(counts.ddg, 0, `DuckDuckGo must not be called after a successful Brave retry (ddg calls=${counts.ddg})`);
      assert.equal(r.provider, 'brave');
      assert.equal(r.results.length, 1, `expected 1 Brave result after retry, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Brave Alpha');
      assert.equal(r.results[0].url, 'https://example.com/brave-a');
      assert.equal(r.results[0].snippet, 'Brave alpha snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('31. Brave 500 then 200 on retry -> provider brave', true);
  } catch (err) {
    report('31. Brave 500 then 200 on retry -> provider brave', false, err.message);
  }

  // (32-43) In-process free-provider chain cases — stub fetchImpl, no
  // network, no keys spent. Agreed contract with lib/search.js
  // (Worker 2): searchWeb(query, { tracker, fetchImpl }) passes
  // fetchImpl to EVERY leg; each leg throws on HTTP error or empty
  // results and the chain falls through; the first non-empty results
  // win with quotaRemaining null (Google CSE excepted). Chain order:
  // Tavily -> Exa -> Firecrawl -> Marginalia -> SearXNG -> Mojeek ->
  // Bing RSS -> Brave -> Google CSE -> DuckDuckGo -> Wikipedia.
  // The stub below dispatches on URL host and counts calls per host.
  // ASSUMPTIONS to reconcile with Worker 2's lib (see handoff report):
  // Exa maps `text` -> snippet; SearXNG maps `content` -> snippet;
  // Wikipedia answers the OpenSearch array shape
  // [query, titles[], descriptions[], urls[]]; Mojeek HTML follows
  // the real SearXNG-documented structure (ul.results-standard >
  // li > a.ob[href] + h2 > a[title] + p.s[snippet]); a 5xx leg is
  // retried once (Brave-leg pattern) while 4xx fails fast.
  const jsonResponse = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });
  const textResponse = (status, text) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => { try { return JSON.parse(text); } catch { return {}; } },
    text: async () => text,
  });
  const zeroCounts = () => ({
    tavily: 0, exa: 0, firecrawl: 0, marginalia: 0, searxng: 0,
    mojeek: 0, bing: 0, brave: 0, cse: 0, ddg: 0, wikipedia: 0,
  });
  // Dispatching stub: routes by URL host (SearXNG host taken from the
  // live process.env.SEARXNG_URL), counts calls per leg, and runs the
  // per-leg impl for that host (default: HTTP 404, so an unexpected
  // leg fails loudly instead of answering). DDG defaults to the canned
  // good page (same as the Brave cases above) when no ddg impl is
  // given. Any URL matching no known host throws — a leg calling
  // somewhere unexpected must fail the case, not silently pass.
  const makeFreeSearchStub = (impls, counts) => async (url) => {
    const u = String(url);
    let searxngHost = '';
    try { searxngHost = new URL(process.env.SEARXNG_URL || '').hostname; } catch { /* SEARXNG_URL unset */ }
    const pick = (key) => {
      counts[key] += 1;
      const impl = impls[key];
      if (typeof impl === 'function') return impl(counts[key]);
      return jsonResponse(404, { error: `no stub for ${key}` });
    };
    if (u.includes('api.tavily.com')) return pick('tavily');
    if (u.includes('api.exa.ai')) return pick('exa');
    if (u.includes('api.firecrawl.dev')) return pick('firecrawl');
    if (u.includes('api2.marginalia-search.com')) return pick('marginalia');
    if (searxngHost) {
      try { if (new URL(u).hostname === searxngHost) return pick('searxng'); } catch { /* not a URL */ }
    }
    if (u.includes('www.mojeek.com')) return pick('mojeek');
    if (u.includes('www.bing.com')) return pick('bing');
    if (u.includes('api.search.brave.com')) return pick('brave');
    if (u.includes('www.googleapis.com')) return pick('cse');
    if (u.includes('html.duckduckgo.com')) return pick('ddg');
    if (u.includes('en.wikipedia.org')) return pick('wikipedia');
    throw new Error('free-search stub: unexpected fetch URL ' + u);
  };
  // Apply env overrides (undefined value = delete the var) and return
  // a restore function. Covers every key the free chain reads, so
  // cases stay hermetic. Always used with try/finally.
  const withFreeSearchEnv = (overrides) => {
    const keys = ['TAVILY_API_KEY', 'EXA_API_KEY', 'FIRECRAWL_API_KEY', 'SEARXNG_URL', 'BRAVE_SEARCH_API_KEY', 'GOOGLE_CSE_API_KEY', 'GOOGLE_CSE_CX'];
    const prev = {};
    for (const key of keys) prev[key] = process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return () => {
      for (const key of keys) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    };
  };
  const freeTestTracker = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-search-'));
    return { dir, tracker: createQuotaTracker(path.join(dir, 'search-quota.json')) };
  };
  // Fail if any leg outside `allowed` was called at all.
  const assertOnlyLegsCalled = (counts, allowed) => {
    for (const [key, n] of Object.entries(counts)) {
      if (!allowed.includes(key)) {
        assert.equal(n, 0, `${key} leg must not be called (${key} calls=${n})`);
      }
    }
  };
  const noKeysEnv = {
    TAVILY_API_KEY: undefined, EXA_API_KEY: undefined, FIRECRAWL_API_KEY: undefined,
    SEARXNG_URL: undefined, BRAVE_SEARCH_API_KEY: undefined,
    GOOGLE_CSE_API_KEY: undefined, GOOGLE_CSE_CX: undefined,
  };
  const allKeysEnv = {
    TAVILY_API_KEY: 'test-tavily-key', EXA_API_KEY: 'test-exa-key',
    FIRECRAWL_API_KEY: 'test-firecrawl-key', SEARXNG_URL: 'http://searxng.test:8080',
    BRAVE_SEARCH_API_KEY: 'test-brave-key',
    GOOGLE_CSE_API_KEY: 'test-cse-key', GOOGLE_CSE_CX: 'test-cse-cx',
  };
  // Canned payloads in the real API shapes (see header note above).
  const tavilyPayload = { results: [
    { title: 'Tavily Alpha', url: 'https://example.com/tavily-a', content: 'Tavily alpha snippet.', score: 0.9 },
    { title: 'Tavily Beta', url: 'https://example.com/tavily-b', content: 'Tavily beta snippet.', score: 0.8 },
  ] };
  const exaPayload = { results: [
    { title: 'Exa Alpha', url: 'https://example.com/exa-a', text: 'Exa alpha snippet.' },
    { title: 'Exa Beta', url: 'https://example.com/exa-b', text: 'Exa beta snippet.' },
  ] };
  const firecrawlPayload = { success: true, data: [
    { title: 'Firecrawl Alpha', url: 'https://example.com/firecrawl-a', description: 'Firecrawl alpha snippet.' },
    { title: 'Firecrawl Beta', url: 'https://example.com/firecrawl-b', description: 'Firecrawl beta snippet.' },
  ] };
  const marginaliaPayload = { query: 'test query', license: 'test', results: [
    { title: 'Marginalia Alpha', url: 'https://example.com/marg-a', description: 'Marginalia alpha snippet.' },
    { title: 'Marginalia Beta', url: 'https://example.com/marg-b', description: 'Marginalia beta snippet.' },
  ] };
  const searxngPayload = { query: 'test query', number_of_results: 2, results: [
    { title: 'SearXNG Alpha', url: 'https://example.com/searxng-a', content: 'SearXNG alpha snippet.', engine: 'test' },
    { title: 'SearXNG Beta', url: 'https://example.com/searxng-b', content: 'SearXNG beta snippet.', engine: 'test' },
  ] };
  // Real Mojeek results markup (SearXNG mojeek engine): each result
  // is an <li> under ul.results-standard with an <a class="ob">
  // carrying the URL, an <h2><a> title, and a <p class="s"> snippet.
  const mojeekGoodPage = `<ul class="results-standard">
<li><a class="ob" href="https://example.com/mojeek-a">example.com/mojeek-a</a><h2><a href="https://example.com/mojeek-a">Mojeek Alpha</a></h2><p class="s">Mojeek alpha snippet.</p></li>
<li><a class="ob" href="https://example.com/mojeek-b">example.com/mojeek-b</a><h2><a href="https://example.com/mojeek-b">Mojeek Beta</a></h2><p class="s">Mojeek beta snippet.</p></li>
</ul>`;
  const mojeekEmptyPage = '<html><body><ul class="results-standard"></ul></body></html>';
  const bingRssGood = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>test query - Bing</title>
<item><title>Bing Alpha</title><link>https://example.com/bing-a</link><description>Bing alpha snippet.</description></item>
<item><title>Bing Beta</title><link>https://example.com/bing-b</link><description>Bing beta snippet.</description></item>
</channel></rss>`;
  const bingRssEmpty = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>test query - Bing</title></channel></rss>';
  // Wikipedia list=search shape: {query:{search:[{title, snippet}]}} —
  // this is what lib/free-providers.js parses (NOT the OpenSearch
  // array shape, which the parser does not accept).
  const wikipediaPayload = { query: { search: [
    { title: 'Wiki Alpha', snippet: 'Wiki alpha snippet.' },
    { title: 'Wiki Beta', snippet: 'Wiki beta snippet.' },
  ] } };
  // DDG default for the free stub (same canned page as cases 27-31).
  const freeDdgImpl = () => ddgResponse(ddgGoodPage);

  // (32) In-process: Tavily 200 -> provider tavily, content mapped
  // to snippet, quotaRemaining null, no other leg called.
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv, TAVILY_API_KEY: 'test-tavily-key' });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({ tavily: () => jsonResponse(200, tavilyPayload), ddg: freeDdgImpl }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.tavily, 1, `Tavily must be called once (tavily calls=${counts.tavily})`);
      assertOnlyLegsCalled(counts, ['tavily']);
      assert.equal(r.provider, 'tavily');
      assert.equal(r.results.length, 2, `expected 2 Tavily results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Tavily Alpha');
      assert.equal(r.results[0].url, 'https://example.com/tavily-a');
      assert.equal(r.results[0].snippet, 'Tavily alpha snippet.', 'content must become snippet');
      assert.equal(r.results[1].title, 'Tavily Beta');
      assert.equal(r.results[1].snippet, 'Tavily beta snippet.');
      assert.equal(r.quotaRemaining, null, `quotaRemaining must be null for Tavily, got: ${r.quotaRemaining}`);
      assert.equal(tracker.remaining(), 100, 'Tavily must not spend CSE quota');
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('32. Tavily 200 -> provider tavily, content -> snippet, no other leg called', true);
  } catch (err) {
    report('32. Tavily 200 -> provider tavily, content -> snippet, no other leg called', false, err.message);
  }

  // (33) In-process: Tavily 401 -> falls through to Exa 200 ->
  // provider exa (4xx fails fast, no retry — Brave-leg pattern).
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv, TAVILY_API_KEY: 'test-tavily-key', EXA_API_KEY: 'test-exa-key' });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({
        tavily: () => jsonResponse(401, { detail: 'Unauthorized' }),
        exa: () => jsonResponse(200, exaPayload),
        ddg: freeDdgImpl,
      }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.ok(counts.tavily >= 1, `Tavily must be attempted (tavily calls=${counts.tavily})`);
      assert.equal(counts.exa, 1, `Exa must answer once (exa calls=${counts.exa})`);
      assertOnlyLegsCalled(counts, ['tavily', 'exa']);
      assert.equal(r.provider, 'exa');
      assert.equal(r.results.length, 2, `expected 2 Exa results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Exa Alpha');
      assert.equal(r.results[0].url, 'https://example.com/exa-a');
      assert.equal(r.results[0].snippet, 'Exa alpha snippet.', 'text must become snippet');
      assert.equal(r.results[1].title, 'Exa Beta');
      assert.equal(r.results[1].snippet, 'Exa beta snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('33. Tavily 401 -> falls through to Exa 200, provider exa', true);
  } catch (err) {
    report('33. Tavily 401 -> falls through to Exa 200, provider exa', false, err.message);
  }

  // (34) In-process: Exa 500 on the first attempt, 200 on the retry
  // -> provider exa, exactly 2 Exa calls (retry-once on 5xx, same as
  // the Brave leg in case 31). Only the Exa key is set, so Tavily is
  // skipped, not failed.
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv, EXA_API_KEY: 'test-exa-key' });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({
        exa: (call) => (call === 1
          ? jsonResponse(500, { error: 'Internal Server Error' })
          : jsonResponse(200, exaPayload)),
        ddg: freeDdgImpl,
      }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.exa, 2, `Exa 500 must be retried once (exa calls=${counts.exa})`);
      assertOnlyLegsCalled(counts, ['exa']);
      assert.equal(r.provider, 'exa');
      assert.equal(r.results.length, 2, `expected 2 Exa results after retry, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Exa Alpha');
      assert.equal(r.results[0].url, 'https://example.com/exa-a');
      assert.equal(r.results[0].snippet, 'Exa alpha snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('34. Exa 500 then 200 on retry -> provider exa, exactly 2 Exa calls', true);
  } catch (err) {
    report('34. Exa 500 then 200 on retry -> provider exa, exactly 2 Exa calls', false, err.message);
  }

  // (35) In-process: Firecrawl 200 -> provider firecrawl,
  // description mapped to snippet. Only the Firecrawl key is set.
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv, FIRECRAWL_API_KEY: 'test-firecrawl-key' });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({ firecrawl: () => jsonResponse(200, firecrawlPayload), ddg: freeDdgImpl }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.firecrawl, 1, `Firecrawl must be called once (firecrawl calls=${counts.firecrawl})`);
      assertOnlyLegsCalled(counts, ['firecrawl']);
      assert.equal(r.provider, 'firecrawl');
      assert.equal(r.results.length, 2, `expected 2 Firecrawl results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Firecrawl Alpha');
      assert.equal(r.results[0].url, 'https://example.com/firecrawl-a');
      assert.equal(r.results[0].snippet, 'Firecrawl alpha snippet.', 'description must become snippet');
      assert.equal(r.results[1].title, 'Firecrawl Beta');
      assert.equal(r.results[1].snippet, 'Firecrawl beta snippet.');
      assert.equal(r.quotaRemaining, null, `quotaRemaining must be null for Firecrawl, got: ${r.quotaRemaining}`);
      assert.equal(tracker.remaining(), 100, 'Firecrawl must not spend CSE quota');
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('35. Firecrawl 200 -> provider firecrawl, description -> snippet', true);
  } catch (err) {
    report('35. Firecrawl 200 -> provider firecrawl, description -> snippet', false, err.message);
  }

  // (36) In-process: Marginalia 200 with NO keys set at all ->
  // provider marginalia (Marginalia needs no env key — the public
  // key — so it is the first leg attempted when no keyed leg is
  // configured).
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({ marginalia: () => jsonResponse(200, marginaliaPayload), ddg: freeDdgImpl }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.marginalia, 1, `Marginalia must be called once (marginalia calls=${counts.marginalia})`);
      assertOnlyLegsCalled(counts, ['marginalia']);
      assert.equal(r.provider, 'marginalia');
      assert.equal(r.results.length, 2, `expected 2 Marginalia results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Marginalia Alpha');
      assert.equal(r.results[0].url, 'https://example.com/marg-a');
      assert.equal(r.results[0].snippet, 'Marginalia alpha snippet.', 'description must become snippet');
      assert.equal(r.results[1].title, 'Marginalia Beta');
      assert.equal(r.results[1].snippet, 'Marginalia beta snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('36. Marginalia 200 with no keys set -> provider marginalia', true);
  } catch (err) {
    report('36. Marginalia 200 with no keys set -> provider marginalia', false, err.message);
  }

  // (37) In-process: Marginalia 503 -> falls through to SearXNG 200
  // (SEARXNG_URL set) -> provider searxng. Marginalia may retry a
  // 5xx once (Brave-leg pattern), so its call count is >= 1, not
  // pinned to exactly 1.
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv, SEARXNG_URL: 'http://searxng.test:8080' });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({
        marginalia: () => jsonResponse(503, { error: 'Service Unavailable' }),
        searxng: () => jsonResponse(200, searxngPayload),
        ddg: freeDdgImpl,
      }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.ok(counts.marginalia >= 1, `Marginalia must be attempted (marginalia calls=${counts.marginalia})`);
      assert.equal(counts.searxng, 1, `SearXNG must answer once (searxng calls=${counts.searxng})`);
      assertOnlyLegsCalled(counts, ['marginalia', 'searxng']);
      assert.equal(r.provider, 'searxng');
      assert.equal(r.results.length, 2, `expected 2 SearXNG results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'SearXNG Alpha');
      assert.equal(r.results[0].url, 'https://example.com/searxng-a');
      assert.equal(r.results[0].snippet, 'SearXNG alpha snippet.', 'content must become snippet');
      assert.equal(r.results[1].title, 'SearXNG Beta');
      assert.equal(r.results[1].snippet, 'SearXNG beta snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('37. Marginalia 503 -> falls through to SearXNG 200, provider searxng', true);
  } catch (err) {
    report('37. Marginalia 503 -> falls through to SearXNG 200, provider searxng', false, err.message);
  }

  // (38) In-process: SEARXNG_URL unset -> the SearXNG leg is skipped
  // (0 calls) and Mojeek HTML 200 answers -> provider mojeek.
  // Marginalia returns 200 with empty results[] so the chain reaches
  // Mojeek at all.
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({
        marginalia: () => jsonResponse(200, { query: 'test query', license: 'test', results: [] }),
        mojeek: () => textResponse(200, mojeekGoodPage),
        ddg: freeDdgImpl,
      }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.marginalia, 1, `Marginalia must be attempted once (marginalia calls=${counts.marginalia})`);
      assert.equal(counts.searxng, 0, `SearXNG must be skipped without SEARXNG_URL (searxng calls=${counts.searxng})`);
      assert.equal(counts.mojeek, 1, `Mojeek must answer once (mojeek calls=${counts.mojeek})`);
      assertOnlyLegsCalled(counts, ['marginalia', 'mojeek']);
      assert.equal(r.provider, 'mojeek');
      assert.equal(r.results.length, 2, `expected 2 Mojeek results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Mojeek Alpha');
      assert.equal(r.results[0].url, 'https://example.com/mojeek-a');
      assert.equal(r.results[0].snippet, 'Mojeek alpha snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('38. SEARXNG_URL unset -> SearXNG skipped (0 calls), Mojeek answers', true);
  } catch (err) {
    report('38. SEARXNG_URL unset -> SearXNG skipped (0 calls), Mojeek answers', false, err.message);
  }

  // (39) In-process: Mojeek HTML 200 -> provider mojeek, titles /
  // URLs / snippets parsed from the HTML (ul.results-standard > li >
  // a.ob + h2 > a + p.s). Marginalia 200 empty so the chain reaches
  // Mojeek; SEARXNG_URL unset so SearXNG is skipped.
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({
        marginalia: () => jsonResponse(200, { query: 'test query', license: 'test', results: [] }),
        mojeek: () => textResponse(200, mojeekGoodPage),
        ddg: freeDdgImpl,
      }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.mojeek, 1, `Mojeek must be called once (mojeek calls=${counts.mojeek})`);
      assert.equal(counts.searxng, 0, `SearXNG must be skipped without SEARXNG_URL (searxng calls=${counts.searxng})`);
      assertOnlyLegsCalled(counts, ['marginalia', 'mojeek']);
      assert.equal(r.provider, 'mojeek');
      assert.equal(r.results.length, 2, `expected 2 Mojeek results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Mojeek Alpha');
      assert.equal(r.results[0].url, 'https://example.com/mojeek-a');
      assert.equal(r.results[0].snippet, 'Mojeek alpha snippet.');
      assert.equal(r.results[1].title, 'Mojeek Beta');
      assert.equal(r.results[1].url, 'https://example.com/mojeek-b');
      assert.equal(r.results[1].snippet, 'Mojeek beta snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('39. Mojeek HTML 200 -> provider mojeek, titles/URLs/snippets parsed', true);
  } catch (err) {
    report('39. Mojeek HTML 200 -> provider mojeek, titles/URLs/snippets parsed', false, err.message);
  }

  // (40) In-process: Bing RSS 200 -> provider bing, RSS items mapped
  // (title / link / description -> snippet). Marginalia 200 empty
  // and Mojeek 200 with no results, so the chain reaches Bing;
  // SEARXNG_URL unset so SearXNG is skipped.
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({
        marginalia: () => jsonResponse(200, { query: 'test query', license: 'test', results: [] }),
        mojeek: () => textResponse(200, mojeekEmptyPage),
        bing: () => textResponse(200, bingRssGood),
        ddg: freeDdgImpl,
      }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.marginalia, 1, `Marginalia must be attempted once (marginalia calls=${counts.marginalia})`);
      assert.equal(counts.mojeek, 1, `Mojeek must be attempted once (mojeek calls=${counts.mojeek})`);
      assert.equal(counts.bing, 1, `Bing must answer once (bing calls=${counts.bing})`);
      assert.equal(counts.searxng, 0, `SearXNG must be skipped without SEARXNG_URL (searxng calls=${counts.searxng})`);
      assertOnlyLegsCalled(counts, ['marginalia', 'mojeek', 'bing']);
      assert.equal(r.provider, 'bing');
      assert.equal(r.results.length, 2, `expected 2 Bing results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Bing Alpha');
      assert.equal(r.results[0].url, 'https://example.com/bing-a');
      assert.equal(r.results[0].snippet, 'Bing alpha snippet.', 'description must become snippet');
      assert.equal(r.results[1].title, 'Bing Beta');
      assert.equal(r.results[1].url, 'https://example.com/bing-b');
      assert.equal(r.results[1].snippet, 'Bing beta snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('40. Bing RSS 200 -> provider bing, RSS items mapped', true);
  } catch (err) {
    report('40. Bing RSS 200 -> provider bing, RSS items mapped', false, err.message);
  }

  // (41) In-process: every leg fails or comes back empty and the
  // DuckDuckGo stub throws -> Wikipedia 200 (OpenSearch) answers ->
  // provider wikipedia. CSE keys are left unset so the CSE leg is
  // skipped instead of attempting a live network call with the
  // global fetch (the Brave code's CSE leg does not take fetchImpl);
  // every other leg is stubbed to fail fast (4xx / empty 200s, no
  // 5xx retries) except the DDG stub, which throws outright.
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...allKeysEnv, GOOGLE_CSE_API_KEY: undefined, GOOGLE_CSE_CX: undefined });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({
        tavily: () => jsonResponse(401, { detail: 'Unauthorized' }),
        exa: () => jsonResponse(401, { error: 'Unauthorized' }),
        firecrawl: () => jsonResponse(401, { error: 'Unauthorized' }),
        marginalia: () => jsonResponse(429, { error: 'Too Many Requests' }),
        searxng: () => jsonResponse(404, { error: 'Not Found' }),
        mojeek: () => textResponse(200, mojeekEmptyPage),
        bing: () => textResponse(200, bingRssEmpty),
        brave: () => braveResponse(401, { message: 'Unauthorized' }),
        ddg: () => { throw new Error('DuckDuckGo stub boom'); },
        wikipedia: () => jsonResponse(200, wikipediaPayload),
      }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.ok(counts.tavily >= 1, `Tavily must be attempted (tavily calls=${counts.tavily})`);
      assert.ok(counts.exa >= 1, `Exa must be attempted (exa calls=${counts.exa})`);
      assert.ok(counts.firecrawl >= 1, `Firecrawl must be attempted (firecrawl calls=${counts.firecrawl})`);
      assert.ok(counts.marginalia >= 1, `Marginalia must be attempted (marginalia calls=${counts.marginalia})`);
      assert.ok(counts.searxng >= 1, `SearXNG must be attempted (searxng calls=${counts.searxng})`);
      assert.ok(counts.mojeek >= 1, `Mojeek must be attempted (mojeek calls=${counts.mojeek})`);
      assert.ok(counts.bing >= 1, `Bing must be attempted (bing calls=${counts.bing})`);
      assert.ok(counts.brave >= 1, `Brave must be attempted (brave calls=${counts.brave})`);
      assert.ok(counts.ddg >= 1, `DuckDuckGo must be attempted (ddg calls=${counts.ddg})`);
      assert.equal(counts.wikipedia, 1, `Wikipedia must answer once (wikipedia calls=${counts.wikipedia})`);
      assertOnlyLegsCalled(counts, ['tavily', 'exa', 'firecrawl', 'marginalia', 'searxng', 'mojeek', 'bing', 'brave', 'ddg', 'wikipedia']);
      assert.equal(r.provider, 'wikipedia');
      assert.equal(r.results.length, 2, `expected 2 Wikipedia results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Wiki Alpha');
      assert.equal(r.results[0].url, 'https://en.wikipedia.org/wiki/Wiki_Alpha');
      assert.equal(r.results[0].snippet, 'Wiki alpha snippet.');
      assert.equal(r.results[1].title, 'Wiki Beta');
      assert.equal(r.results[1].url, 'https://en.wikipedia.org/wiki/Wiki_Beta');
      assert.equal(r.results[1].snippet, 'Wiki beta snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('41. All legs fail/empty, DDG throws -> Wikipedia 200, provider wikipedia', true);
  } catch (err) {
    report('41. All legs fail/empty, DDG throws -> Wikipedia 200, provider wikipedia', false, err.message);
  }

  // (42) In-process: chain order — ALL keys set, Tavily stub 200 ->
  // provider tavily, Exa and Firecrawl never called (0 times), and
  // CSE quota untouched despite CSE being configured.
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...allKeysEnv });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({ tavily: () => jsonResponse(200, tavilyPayload), ddg: freeDdgImpl }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.tavily, 1, `Tavily must be called once (tavily calls=${counts.tavily})`);
      assert.equal(counts.exa, 0, `Exa must not be called when Tavily answers first (exa calls=${counts.exa})`);
      assert.equal(counts.firecrawl, 0, `Firecrawl must not be called when Tavily answers first (firecrawl calls=${counts.firecrawl})`);
      assertOnlyLegsCalled(counts, ['tavily']);
      assert.equal(r.provider, 'tavily');
      assert.equal(r.results.length, 2, `expected 2 Tavily results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'Tavily Alpha');
      assert.equal(r.results[0].snippet, 'Tavily alpha snippet.');
      assert.equal(r.quotaRemaining, null);
      assert.equal(tracker.remaining(), 100, 'CSE quota must be untouched when Tavily answers first');
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('42. All keys set, Tavily 200 -> provider tavily, Exa/Firecrawl 0 calls', true);
  } catch (err) {
    report('42. All keys set, Tavily 200 -> provider tavily, Exa/Firecrawl 0 calls', false, err.message);
  }

  // (43) In-process: empty results fall through — Marginalia 200
  // with empty results[] -> SearXNG 200 -> provider searxng. No API
  // keys; SEARXNG_URL set. A 200 with empty results must not be
  // retried (Marginalia called exactly once).
  try {
    const { dir, tracker } = freeTestTracker();
    const restoreEnv = withFreeSearchEnv({ ...noKeysEnv, SEARXNG_URL: 'http://searxng.test:8080' });
    try {
      const counts = zeroCounts();
      const fetchStub = makeFreeSearchStub({
        marginalia: () => jsonResponse(200, { query: 'test query', license: 'test', results: [] }),
        searxng: () => jsonResponse(200, searxngPayload),
        ddg: freeDdgImpl,
      }, counts);
      const r = await searchWeb('test query', { tracker, fetchImpl: fetchStub });
      assert.equal(counts.marginalia, 1, `Marginalia must be called exactly once (marginalia calls=${counts.marginalia})`);
      assert.equal(counts.searxng, 1, `SearXNG must answer once (searxng calls=${counts.searxng})`);
      assertOnlyLegsCalled(counts, ['marginalia', 'searxng']);
      assert.equal(r.provider, 'searxng');
      assert.equal(r.results.length, 2, `expected 2 SearXNG results, got: ${JSON.stringify(r.results)}`);
      assert.equal(r.results[0].title, 'SearXNG Alpha');
      assert.equal(r.results[0].url, 'https://example.com/searxng-a');
      assert.equal(r.results[0].snippet, 'SearXNG alpha snippet.', 'content must become snippet');
      assert.equal(r.results[1].title, 'SearXNG Beta');
      assert.equal(r.results[1].snippet, 'SearXNG beta snippet.');
      assert.equal(r.quotaRemaining, null);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    report('43. Marginalia 200 empty results -> SearXNG 200, provider searxng', true);
  } catch (err) {
    report('43. Marginalia 200 empty results -> SearXNG 200, provider searxng', false, err.message);
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
