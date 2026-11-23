# Push Notifications (FCM) — Nexus Browser Worker

The server can now send Firebase Cloud Messaging (FCM) push notifications
to the Nexus Android app. This is how the app learns a long-running browser
job finished — or paused needing the user (CAPTCHA / 2FA) — without polling
forever.

Everything is **free**: the Firebase Admin SDK runs on this server (Railway
free tier and the Render copy). No Cloud Functions, no Blaze plan, no card.

## What was added

| File | Change |
| --- | --- |
| `lib/push.js` (new) | Firebase Admin SDK init from `FIREBASE_SERVICE_ACCOUNT_JSON`; exports `sendPush(token, {title, body, data})`, `isConfigured()`, `maskToken()`. |
| `server.js` | `POST /api/notify` behind the existing `requireAuth` (`x-api-key`); job queue wired with an `onJobEvent` hook; `POST /api/job` accepts an optional `fcmToken`; `POST /api/job/:id/resume` accepts a fresh `fcmToken`. |
| `lib/jobQueue.js` | Optional `onJobEvent(event, job)` callback, fired best-effort on `done` and `paused-needs-user`. Errors are swallowed — a push failure never fails the job or changes its status. |
| `package.json` / `package-lock.json` | Added `firebase-admin` dependency. |
| `.env.example` | Documents `FIREBASE_SERVICE_ACCOUNT_JSON`. |

## How it works

1. **Direct send — `POST /api/notify`** (auth: `x-api-key: <BROWSER_WORKER_KEY>`)

   ```json
   { "token": "<FCM device token>", "title": "Nexus: কাজ শেষ", "body": "Your job is done.", "data": { "jobId": "..." } }
   ```

   Success: `{ "ok": true, "messageId": "projects/nexus-ai-9df20/messages/..." }`
   Validation errors: `400`. Push not configured (no service-account env
   var): `503` with a clear message. FCM send failure: `502`.

   Validation: `token` (string, 10–4096 chars), `title` (string, max 200
   chars), `body` (string, max 1000 chars) are required; `data` must be an
   object of string values (all values are coerced to strings — FCM data
   values must be strings). The token is **never logged in full** — only
   its first/last 4 characters.

2. **Job completion hook** — when the Nexus app creates a job
   (`POST /api/job`), it may include an optional `fcmToken` in the request
   body. The token is stored on the job's params (never logged, never
   returned by `GET /api/job/:id` / `GET /api/jobs` — `publicJob()` strips
   params). When the job reaches `done` or `paused-needs-user`, the server
   sends a push to that token:

   - Done: title `Nexus: কাজ শেষ · Job done`, body names the job id + type.
   - Paused: title `Nexus: আপনার সাহায্য দরকার · Needs you`, body carries
     the pause reason + takeover info. Data payload: `{ jobId, type, event,
     status }`.

   The hook is best-effort: any push failure is logged (token masked) and
   the job's status/result are untouched. If no `fcmToken` was supplied,
   nothing is sent.

3. **Fail-soft** — if `FIREBASE_SERVICE_ACCOUNT_JSON` is absent or invalid
   JSON, the server logs ONE warning at startup and keeps running normally.
   `sendPush()` rejects with a `PUSH_NOT_CONFIGURED` error; `/api/notify`
   answers `503`. Nothing crashes.

## The one manual step (user must do this)

Push does **not** work until the service-account key is set. The key itself
is **NEVER** in this repo, never committed, never pasted into chat.

1. Open the Firebase console → project **nexus-ai-9df20** → **Project
   settings** → **Service accounts** → **Generate new private key**.
   Download the JSON file.
2. In Railway, open the `nexus-browser-worker` service → **Variables** →
   add `FIREBASE_SERVICE_ACCOUNT_JSON` with the **entire JSON file
   contents as one string** (paste the file's text verbatim).
3. Redeploy (Railway redeploys automatically when the variable changes, or
   trigger a redeploy manually). Check the deploy logs for
   `[push] Firebase Admin SDK initialized (project: nexus-ai-9df20).`

**Render copy:** the Render service needs the exact same
`FIREBASE_SERVICE_ACCOUNT_JSON` variable set in its Environment settings,
or its `/api/notify` will answer `503` and its job hooks will silently
skip pushes.

## Test (after the env var is set on Railway)

Get a real FCM device token from the Nexus Android app (it logs/prints it
in Settings once the app registers with Firebase; the token is per-device
and can rotate — the app should send its current token with each job).

```bash
# 1. Server is up and push is configured:
curl -s https://nexus-browser-worker-production.up.railway.app/health

# 2. Send a test push (replace <BROWSER_WORKER_KEY> and <FCM_TOKEN>):
curl -s -X POST https://nexus-browser-worker-production.up.railway.app/api/notify \
  -H "x-api-key: <BROWSER_WORKER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"token":"<FCM_TOKEN>","title":"Nexus test","body":"Push is working.","data":{"test":"1"}}'
# Expected: {"ok":true,"messageId":"projects/nexus-ai-9df20/messages/..."}
# The phone should show the notification within seconds.
```

Before the env var is set, the same call returns `503` with
`"push not configured: set the FIREBASE_SERVICE_ACCOUNT_JSON env var …"` —
that is the expected fail-soft behaviour, not a bug.

## Job test (after the env var is set)

```bash
curl -s -X POST https://nexus-browser-worker-production.up.railway.app/api/job \
  -H "x-api-key: <BROWSER_WORKER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"type":"read","url":"https://example.com","fcmToken":"<FCM_TOKEN>"}'
# When the job finishes, the phone gets "Nexus: কাজ শেষ · Job done".
```

## Follow-up (not done yet)

- **Firestore token lookup:** the server does not yet look up a device
  token from Firestore (`nexus_users/{uid}/fcm_tokens`) when a job has a
  `uid` but no `fcmToken` in the request. The request-token path above is
  the working route for now; the app should send its current FCM token
  with each job (and on resume). A Firestore lookup via the Admin SDK
  can be added later if the app stops sending the token.
- **App side:** the Nexus Android app must (a) register with Firebase and
  obtain its FCM token, (b) send it as `fcmToken` in `POST /api/job`
  (and on resume), and (c) show the notification / deep-link to the job
  when a push with `data.event = "paused-needs-user"` arrives. None of
  that is in this repo.
