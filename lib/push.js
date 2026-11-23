'use strict';
/**
 * push.js — Firebase Cloud Messaging (FCM) push notifications for Nexus.
 *
 * Sends push notifications to the Nexus Android app via the Firebase
 * Admin SDK. Free-tier friendly: firebase-admin runs on this server
 * (Railway / Render free tier), no Cloud Functions / Blaze plan needed.
 *
 * Setup (one manual step, done by the user in the Firebase console):
 *   1. Firebase console -> project nexus-ai-9df20 -> Project settings
 *      -> Service accounts -> "Generate new private key".
 *   2. Set the resulting JSON as the FIREBASE_SERVICE_ACCOUNT_JSON env var
 *      on Railway (and on the Render copy, if used). The value is the whole
 *      JSON file contents as one string. The key itself is NEVER in the
 *      repo, NEVER committed, NEVER logged.
 *
 * Fail-soft by design: if FIREBASE_SERVICE_ACCOUNT_JSON is absent or
 * invalid, the module logs ONE clear warning at startup and keeps the
 * server running. sendPush() then rejects with a "push not configured"
 * error instead of crashing anything. Callers must treat push as
 * best-effort (a push failure must never fail a job or change its status).
 *
 * Tokens are sensitive: this module never logs a token in full — only
 * the first/last 4 characters for debugging.
 */

let admin = null;
let configured = false;
let configError = null;

const RAW = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';

if (!RAW) {
  console.warn(
    '[push] FIREBASE_SERVICE_ACCOUNT_JSON is not set — push notifications are disabled. ' +
      'Generate a service-account key in the Firebase console (project nexus-ai-9df20, ' +
      'Project settings > Service accounts > Generate new private key) and set it as ' +
      'the FIREBASE_SERVICE_ACCOUNT_JSON env var on Railway/Render.',
  );
} else {
  try {
    const serviceAccount = JSON.parse(RAW);
    // eslint-disable-next-line global-require
    admin = require('firebase-admin');
    if (admin.apps.length === 0) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    configured = true;
    console.log('[push] Firebase Admin SDK initialized (project: ' + (serviceAccount.project_id || 'unknown') + ').');
  } catch (err) {
    configError = err && err.message ? String(err.message) : String(err);
    console.warn(
      '[push] FIREBASE_SERVICE_ACCOUNT_JSON is set but invalid — push notifications are disabled. ' +
        'Error: ' + configError,
    );
  }
}

/** True when the Admin SDK is initialized and ready to send. */
function isConfigured() {
  return configured;
}

/** Mask a device token for logging: first 4 + '…' + last 4 chars only. */
function maskToken(token) {
  if (typeof token !== 'string' || token.length <= 8) return '****';
  return token.slice(0, 4) + '…' + token.slice(-4);
}

/**
 * Send a push notification to one device token.
 *
 * @param {string} token  FCM device token (from the Nexus Android app).
 * @param {object} opts
 * @param {string} opts.title  Notification title (required, max 200 chars).
 * @param {string} opts.body   Notification body (required, max 1000 chars).
 * @param {object} [opts.data] Extra string->string data payload (all values
 *   are coerced to strings; FCM data values must be strings).
 * @returns {Promise<string>} The FCM message id.
 * @throws {Error} with code 'PUSH_NOT_CONFIGURED' when the Admin SDK is
 *   not initialized, or the underlying FCM error otherwise.
 */
async function sendPush(token, opts) {
  const o = opts || {};
  if (!configured || !admin) {
    const err = new Error(
      'push not configured: set the FIREBASE_SERVICE_ACCOUNT_JSON env var ' +
        '(service-account key for Firebase project nexus-ai-9df20) — see docs/PUSH_NOTIFICATIONS.md',
    );
    err.code = 'PUSH_NOT_CONFIGURED';
    throw err;
  }
  if (!token || typeof token !== 'string') {
    const err = new Error('token is required');
    err.code = 'PUSH_INVALID_TOKEN';
    throw err;
  }
  if (!o.title || typeof o.title !== 'string') {
    const err = new Error('title is required');
    err.code = 'PUSH_INVALID_TITLE';
    throw err;
  }
  if (!o.body || typeof o.body !== 'string') {
    const err = new Error('body is required');
    err.code = 'PUSH_INVALID_BODY';
    throw err;
  }

  const data = {};
  if (o.data && typeof o.data === 'object') {
    for (const [k, v] of Object.entries(o.data)) {
      if (v === undefined || v === null) continue;
      data[String(k)] = String(v);
    }
  }

  const messageId = await admin.messaging().send({
    token,
    notification: { title: o.title, body: o.body },
    data,
    android: { priority: 'high' },
  });
  console.log('[push] sent to ' + maskToken(token) + ' — messageId ' + messageId);
  return messageId;
}

module.exports = { sendPush, isConfigured, maskToken };
