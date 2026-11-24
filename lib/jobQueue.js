'use strict';
/**
 * JobQueue — long-running browser jobs for the Nexus browser worker.
 *
 * The existing /api/browse and /api/read endpoints answer synchronously
 * (60s task timeout, one task at a time). Some flows — logins, multi-step
 * forms, downloads, anything that needs the user to take over in their own
 * browser — take longer than one request can wait for. Those flows become
 * jobs here:
 *
 *   createJob(type, params)  -> id (or null when the queue is full)
 *   runJob(job, handler)     -> runs handler(job, update) with a timeout
 *   pauseJob(id, reason, takeoverUrl) -> 'paused-needs-user'
 *   resumeJob(id)            -> back to 'queued', re-runnable with the
 *                              original params
 *
 * Jobs live only in memory (Railway free tier has no persistent volume).
 * Results are kept until the app fetches them; a sweep every 5 minutes
 * deletes stale jobs (see sweep()).
 *
 * No new dependencies. Job params may contain cookies / credentials, so
 * they are NEVER logged and are stripped from every public view
 * (publicJob / listJobs). The integrator must use publicJob() for API
 * responses.
 */

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per job
const DEFAULT_MAX_JOBS = 20;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 minutes
const DEFAULT_RETENTION_MS = 30 * 60 * 1000; // delete terminal jobs older than 30 min
const DEFAULT_FETCHED_RETENTION_MS = 10 * 60 * 1000; // delete fetched jobs after 10 min

const TIMEOUT_ERROR_BN_EN = 'সময় শেষ — ১০ মিনিট পেরিয়ে গেছে · Timed out after 10 minutes';
const TOO_MANY_JOBS_BN_EN = 'অনেক কাজ জমে আছে — একটু পরে চেষ্টা করুন · Too many jobs queued — try again shortly';

function nowIso() {
  return new Date().toISOString();
}

function clampProgress(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Timeout message in BN+EN. With the default 10-minute timeout this is
// exactly the canonical string above; a custom (e.g. test) timeout names
// its own duration instead.
function timeoutMessage(timeoutMs) {
  if (timeoutMs === DEFAULT_TIMEOUT_MS) return TIMEOUT_ERROR_BN_EN;
  if (timeoutMs >= 60000) {
    const mins = Math.round(timeoutMs / 60000);
    return 'সময় শেষ — ' + mins + ' মিনিট পেরিয়ে গেছে · Timed out after ' + mins + ' minute' + (mins === 1 ? '' : 's');
  }
  return 'সময় শেষ · Timed out after ' + timeoutMs + 'ms';
}

class JobQueue {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] per-job timeout (default 10 min)
   * @param {number} [opts.maxJobs] max jobs held in memory (default 20)
   * @param {number} [opts.sweepIntervalMs] cleanup sweep period (default 5 min)
   * @param {number} [opts.retentionMs] delete terminal jobs older than this (default 30 min)
   * @param {number} [opts.fetchedRetentionMs] delete fetched jobs after this (default 10 min)
   * @param {boolean} [opts.autoSweep] start the interval sweep (default true; pass false in tests)
   * @param {function} [opts.onJobEvent] optional callback (event, job) fired
   *   best-effort when a job reaches 'done' or 'paused-needs-user' — used
   *   by the server to send a push notification (see lib/push.js). The
   *   callback's errors are swallowed; a push failure must NEVER fail the
   *   job or change its status. The job's FCM token, if the app supplied
   *   one, lives in job.params.fcmToken (never logged, never in publicJob).
   */
  constructor(opts) {
    const o = opts || {};
    this.timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxJobs = o.maxJobs || DEFAULT_MAX_JOBS;
    this.sweepIntervalMs = o.sweepIntervalMs || DEFAULT_SWEEP_INTERVAL_MS;
    this.retentionMs = o.retentionMs || DEFAULT_RETENTION_MS;
    this.fetchedRetentionMs = o.fetchedRetentionMs || DEFAULT_FETCHED_RETENTION_MS;
    this.jobs = new Map();
    this._sweepTimer = null;
    this._runSeq = 0; // guards against a late handler settling after timeout/failure
    this.onJobEvent = typeof o.onJobEvent === 'function' ? o.onJobEvent : null;
    if (o.autoSweep !== false) this.startSweep();
  }

  // -- push-notification hook (best-effort, never fails a job) ---------------

  /**
   * Fire the onJobEvent callback, if one was registered. Any throw or
   * rejection is logged and swallowed — push is best-effort and must never
   * change a job's status or outcome.
   */
  _notify(event, job) {
    if (!this.onJobEvent) return;
    try {
      const r = this.onJobEvent(event, job);
      if (r && typeof r.catch === 'function') {
        r.catch((err) => console.warn('[jobQueue] push notify failed:', err && err.message ? err.message : err));
      }
    } catch (err) {
      console.warn('[jobQueue] push notify failed:', err && err.message ? err.message : err);
    }
  }

  // -- creation / lookup -----------------------------------------------------

  /**
   * Create a job. Returns the job id, or null when the queue already holds
   * maxJobs jobs — the integrator must answer 429 with TOO_MANY_JOBS_BN_EN.
   * `params` are stored on the job (so resume can re-execute) but are never
   * logged and never appear in publicJob()/listJobs().
   */
  createJob(type, params) {
    if (this.jobs.size >= this.maxJobs) return null;
    if (!type || typeof type !== 'string') return null;
    const t = nowIso();
    const job = {
      id: crypto.randomUUID(),
      type,
      params: params || {},
      status: 'queued',
      progress: 0,
      // Live page URL of the browser-loop run, updated per step update
      // (A1 mini-browser mirroring). Null until the loop reports one;
      // publicJob()/GET /api/job/:id expose it with no endpoint change.
      // Only http(s) URLs are ever stored — 'about:blank' and anything
      // else a handler passes is ignored by update().
      currentUrl: null,
      steps: [],
      result: null,
      error: null,
      createdAt: t,
      updatedAt: t,
      fetchedAt: null,
    };
    this.jobs.set(job.id, job);
    return job.id;
  }

  /** The stored job object, or null. (Internal use — contains params.) */
  getJob(id) {
    return this.jobs.get(id) || null;
  }

  /**
   * Summaries for listing: no params, no result payload, no step history —
   * just status, progress, step count and timestamps.
   */
  listJobs() {
    return [...this.jobs.values()].map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      stepCount: job.steps.length,
      lastStep: job.steps.length ? job.steps[job.steps.length - 1].text : null,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      fetchedAt: job.fetchedAt,
    }));
  }

  /**
   * Public view of one job for API responses: everything except params.
   * Returns null for an unknown id.
   */
  publicJob(id) {
    const job = this.getJob(id);
    if (!job) return null;
    const { params, ...pub } = job;
    return pub;
  }

  /**
   * Mark a job as fetched by the app (call from GET /api/job/:id).
   * Fetched jobs are swept 10 minutes after fetching. Returns the job or null.
   */
  markFetched(id) {
    const job = this.getJob(id);
    if (!job) return null;
    job.fetchedAt = nowIso();
    job.updatedAt = job.fetchedAt;
    return job;
  }

  // -- execution -------------------------------------------------------------

  /**
   * Run a job's handler: handler(job, update) => result, where
   * update(stepText, progress, currentUrl) appends a step {t, text} and
   * sets progress. The optional third argument is the job's live page
   * URL (browser-loop runs pass the current page URL on every step):
   * when it is a non-empty http(s) URL it is stored as the job's
   * top-level `currentUrl`, updated in place per step. It is never
   * written into the step text — steps stay plain {t, text} — and a
   * missing / blank / non-http(s) value leaves currentUrl unchanged.
   * The handler races against the per-job timeout — job.params.timeoutMs
   * when it is a positive number, else the queue default (10 min). On
   * timeout (or throw) the job is marked 'failed' with a BN+EN error
   * string. Resolves to the finished job. A handler that settles after
   * its job already failed (timeout) is ignored — its late result never
   * overwrites the failure. A job cancelled mid-flight (cancelJob sets
   * status 'cancelled' + job._cancelled) is returned as-is — never
   * marked done/failed — on both the success and the throw path.
   */
  async runJob(job, handler) {
    if (!job || typeof handler !== 'function') {
      throw new Error('runJob requires a job and a handler function');
    }
    const runId = ++this._runSeq;
    job._runId = runId;
    job.status = 'running';
    job.progress = 0;
    job.error = null;
    job.result = null;
    job.updatedAt = nowIso();

    const update = (stepText, progress, currentUrl) => {
      // Ignore updates from a superseded / already-finished run.
      if (job._runId !== runId || job.status !== 'running') return;
      job.steps.push({ t: nowIso(), text: String(stepText == null ? '' : stepText) });
      const p = clampProgress(progress);
      if (p !== null) job.progress = p;
      // Live page URL (browser-loop only): top-level field, updated per
      // step. Kept out of the step text — the app parses steps[].text
      // as plain text. Only http(s) URLs count: 'about:blank' (a loop
      // with no start URL) and any junk value leave it unchanged.
      if (typeof currentUrl === 'string' && /^https?:\/\//.test(currentUrl)) {
        job.currentUrl = currentUrl;
      }
      job.updatedAt = nowIso();
    };

    // Per-job timeout: job.params.timeoutMs wins when it is a positive
    // number (e.g. the aistudio-build route sets build window + 2 min);
    // otherwise the queue default.
    const timeoutMs = (job.params && typeof job.params.timeoutMs === 'number' && job.params.timeoutMs > 0)
      ? job.params.timeoutMs
      : this.timeoutMs;

    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(timeoutMessage(timeoutMs));
        err.code = 'JOB_TIMEOUT';
        reject(err);
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        Promise.resolve().then(() => handler(job, update)),
        timeoutPromise,
      ]);
      if (job._runId !== runId) return job; // superseded; leave the newer run alone
      if (job.status === 'paused-needs-user') return job; // handler paused mid-flight (CAPTCHA/2FA); keep the pause
      if (job.status === 'cancelled') return job; // cancelled mid-flight; keep the cancel, do not mark done
      job.status = 'done';
      job.result = result === undefined ? null : result;
      job.progress = 100;
      job.updatedAt = nowIso();
      this._notify('done', job);
      return job;
    } catch (err) {
      if (job._runId !== runId) return job; // superseded; leave the newer run alone
      if (job.status === 'paused-needs-user') return job; // handler paused, then threw; keep the pause
      if (job.status === 'cancelled') return job; // cancelled, then threw; keep the cancel, do not mark failed
      job.status = 'failed';
      const msg = err && err.message ? String(err.message) : String(err);
      job.error = err && err.code === 'JOB_TIMEOUT'
        ? msg
        : 'ব্যর্থ হয়েছে · Failed: ' + msg;
      job.updatedAt = nowIso();
      return job;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -- pause / resume ----------------------------------------------------------

  /**
   * Pause a job that needs the user (e.g. a CAPTCHA / 2FA step the server
   * cannot do). Status becomes 'paused-needs-user' and result carries the
   * takeover URL + reason so the app can hand the browser to the user.
   * Returns the job, or null for an unknown id.
   */
  pauseJob(id, reason, takeoverUrl) {
    const job = this.getJob(id);
    if (!job) return null;
    job.status = 'paused-needs-user';
    job.result = { takeoverUrl: takeoverUrl || null, reason: reason || '' };
    job.steps.push({ t: nowIso(), text: 'থেমে গেছে — আপনার সাহায্য দরকার · Paused — needs you: ' + (reason || '') });
    job.updatedAt = nowIso();
    this._notify('paused-needs-user', job);
    return job;
  }

  /**
   * Put a paused job back to 'queued' so its handler can be re-run with
   * the original stored params. Only paused jobs can be resumed.
   * Returns the job, or null for an unknown id / a job that is not paused.
   */
  resumeJob(id) {
    const job = this.getJob(id);
    if (!job || job.status !== 'paused-needs-user') return null;
    job.status = 'queued';
    job.result = null;
    job.error = null;
    job.progress = 0;
    job.steps.push({ t: nowIso(), text: 'আবার শুরু হচ্ছে · Resuming…' });
    job.updatedAt = nowIso();
    return job;
  }

  /**
   * Cancel a job (queued, running, or paused-needs-user). Status becomes
   * 'cancelled' and job._cancelled is set so the running handler can
   * notice between steps and stop; runJob() keeps the 'cancelled'
   * status instead of marking the job done/failed when the handler
   * settles. No push notification is sent on cancel. The route layer
   * rejects cancelling an already-terminal job (done/failed/cancelled)
   * with 400 — cancelJob itself just marks whatever it finds.
   * Returns the job, or null for an unknown id.
   */
  cancelJob(id) {
    const job = this.getJob(id);
    if (!job) return null;
    job.status = 'cancelled';
    job._cancelled = true;
    job.steps.push({ t: nowIso(), text: 'বাতিল করা হয়েছে · Cancelled' });
    job.updatedAt = nowIso();
    return job;
  }

  // -- cleanup -----------------------------------------------------------------

  /**
   * Delete stale jobs:
   *  - done/failed jobs older than retentionMs (30 min), or fetched more
   *    than fetchedRetentionMs ago (10 min);
   *  - queued jobs older than retentionMs (never started — stale).
   * Paused-needs-user jobs are NEVER swept: they wait on a human, who may
   * take longer than 30 minutes to come back. Running jobs are never swept
   * either (their 10-minute timeout bounds them). Returns the number deleted.
   */
  sweep() {
    const now = Date.now();
    let deleted = 0;
    for (const [id, job] of this.jobs) {
      const age = now - Date.parse(job.createdAt);
      const fetchedAge = job.fetchedAt ? now - Date.parse(job.fetchedAt) : null;
      let stale = false;
      if (job.status === 'done' || job.status === 'failed') {
        stale = age > this.retentionMs || (fetchedAge !== null && fetchedAge > this.fetchedRetentionMs);
      } else if (job.status === 'queued') {
        stale = age > this.retentionMs;
      }
      if (stale) {
        this.jobs.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  startSweep() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => {
      try { this.sweep(); } catch (err) { console.warn('job sweep failed:', err.message); }
    }, this.sweepIntervalMs);
    if (this._sweepTimer.unref) this._sweepTimer.unref(); // never hold the process open
  }

  stopSweep() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }
}

module.exports = { JobQueue, TIMEOUT_ERROR_BN_EN, TOO_MANY_JOBS_BN_EN };
