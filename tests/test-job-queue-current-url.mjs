// tests/test-job-queue-current-url.mjs — tests for the A1 mini-browser
// mirroring field on JobQueue: update(stepText, progress, currentUrl)
// stores the live page URL as the job's top-level `currentUrl`, updated
// per step, and never writes it into the step text.
// Node built-ins only (node:test + node:assert). No browser, no network:
//
//   node --test tests/test-job-queue-current-url.mjs
//
// Exit code: 0 = all cases PASS, non-zero = at least one FAIL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JobQueue } = require('../lib/jobQueue.js');

function makeQueue() {
  return new JobQueue({ timeoutMs: 60 * 1000, maxJobs: 20 });
}

test('createJob starts with currentUrl null', () => {
  const q = makeQueue();
  const id = q.createJob('browser-loop', { task: 'open example.com' });
  const job = q.getJob(id);
  assert.equal(job.currentUrl, null);
  // The public view (GET /api/job/:id) carries the field, minus params.
  const pub = q.publicJob(id);
  assert.equal(pub.currentUrl, null);
  assert.equal(pub.params, undefined);
});

test('update stores an http(s) currentUrl and keeps steps plain text', async () => {
  const q = makeQueue();
  const id = q.createJob('browser-loop', { task: 't' });
  const job = q.getJob(id);
  await q.runJob(job, async (j, update) => {
    update('Opening page…', 15, 'https://example.com/shop');
    update('Deciding step 1…', 25, 'https://example.com/shop/item-2');
    return { ok: true };
  });
  assert.equal(job.currentUrl, 'https://example.com/shop/item-2');
  // Steps stay {t, text} — the URL is a separate field, never in text.
  assert.equal(job.steps.length, 2);
  for (const s of job.steps) {
    assert.deepEqual(Object.keys(s).sort(), ['t', 'text']);
    assert.equal(s.text.includes('example.com'), false);
  }
  // The terminal public view still carries the last live URL.
  assert.equal(q.publicJob(id).currentUrl, 'https://example.com/shop/item-2');
});

test('update ignores missing, blank and non-http(s) URLs', async () => {
  const q = makeQueue();
  const id = q.createJob('browser-loop', { task: 't' });
  const job = q.getJob(id);
  await q.runJob(job, async (j, update) => {
    update('Acquiring browser…', 5); // no page yet — no third arg
    update('Opening page…', 15, 'about:blank'); // no start URL yet
    update('Still opening…', 16, '');
    update('Still opening…', 17, 'javascript:alert(1)');
    update('Observing page…', 20, 'https://example.com/real');
    update('Deciding…', 25, undefined); // a later step without a URL
    return { ok: true };
  });
  assert.equal(job.currentUrl, 'https://example.com/real');
});

test('two-arg updates from other handlers leave currentUrl null', async () => {
  const q = makeQueue();
  const id = q.createJob('job', { url: 'https://example.com' });
  const job = q.getJob(id);
  await q.runJob(job, async (j, update) => {
    update('Downloading…', 20);
    update('Reading text…', 60);
    return { ok: true };
  });
  assert.equal(job.currentUrl, null);
  assert.equal(job.steps.length, 2);
});
