// Nexus browser-worker server — smoke tests for the NEW job endpoints.
// Node built-ins only (node:http + node:assert). No new npm dependencies.
//
// Assumes the server is ALREADY running (the verifier starts it with
// BROWSER_WORKER_KEY=$TEST_API_KEY). Do NOT spawn the server here.
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

// Poll GET /api/job/:id until a terminal status, max 60 s, 2 s interval.
async function waitForTerminal(jobId) {
  const deadline = Date.now() + 60_000;
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
  assert.fail(`job ${jobId} did not reach a terminal status within 60s (last status: ${last?.body?.status ?? 'unknown'})`);
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
