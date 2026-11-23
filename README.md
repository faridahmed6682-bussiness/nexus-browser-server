# Nexus Browser Worker

Cloud browser server for **Nexus AI** — it does the **heavy browser work** the
Android app cannot do on-device: full Chromium automation, logins, file
uploads, multi-step flows. Same role as Muse's cloud browser, but for Nexus.

The app handles light browsing itself (in-app WebView). When a task needs a
real desktop browser, the app sends it here and gets the result back.

**Free plans only.** Node.js + Playwright (Chromium). No paid service anywhere.

## How it works

- One Chromium instance, **one task at a time** (a small queue, max 5 waiting)
  — this keeps RAM low enough for a free 512 MB container.
- A **fresh browser context per task**: no cookies or logins leak between tasks.
  Every task starts logged out; a login must be scripted as steps each time.
- Pages/contexts are closed after every task; each task times out after 60s.
- Auth: every `/api/*` call needs header `x-api-key: <BROWSER_WORKER_KEY>`.
  The key lives only in the `BROWSER_WORKER_KEY` env var — never in code.
  If the env var is not set, the API refuses everything (503).

## Endpoints

### `GET /health` (no auth)
```json
{"ok":true,"status":"up","browser":"idle","queuedTasks":0,"uptimeSec":123}
```

### `POST /api/browse` (auth)
Run a scripted browser task. Body:

```json
{
  "url": "https://example.com/login",
  "steps": [
    {"action": "type",   "selector": "#email",    "text": "user@example.com"},
    {"action": "type",   "selector": "#password", "text": "secret"},
    {"action": "click",  "selector": "button[type=submit]"},
    {"action": "wait",   "selector": ".dashboard"},
    {"action": "readText"},
    {"action": "screenshot"}
  ]
}
```

Actions: `goto` (needs `url` or `text`), `click` (`selector`),
`type` (`selector`, `text` — clears the field first, then types),
`select` (`selector`, `text` — option value, falls back to label),
`wait` (`selector` to wait for, or `timeoutMs` to sleep, max 30s),
`readText`, `screenshot`. Each step accepts `timeoutMs` (default 15000).

If `url` is given, the browser opens it first; a `goto` step can navigate
further. Response:

```json
{
  "ok": true,
  "url": "https://example.com/dashboard",
  "title": "Dashboard",
  "text": "...visible page text (max 20000 chars)...",
  "truncated": false,
  "screenshotBase64": "...only when a screenshot step ran..."
}
```

### `POST /api/read` (auth)
Fetch a URL and return its readable text — the simple case:

```json
{"url": "https://example.com/article"}
```
```json
{"ok": true, "url": "https://example.com/article", "title": "...", "text": "...", "truncated": false}
```

Errors are always `{ok:false, error:"..."}` (401 bad key, 429 queue full,
400 bad request, 500/503 failure).

## Browser upgrades — long jobs, screenshots, form fill, downloads

The old `/api/browse` and `/api/read` endpoints above are unchanged (one
task at a time, 60 s timeout). The new endpoints below run through a **job
queue** and a **pool of browser contexts** instead — for flows that take
longer than one request: logins, multi-step forms, file downloads, and
pages that stop the worker with a CAPTCHA. Code: `server.js` + `lib/`.

How it works:

- **Job queue** (`lib/jobQueue.js`): a job runs for up to **10 minutes**;
  the app creates it and polls for the result. At most **20 jobs** are
  held in memory (429 when full). Jobs live only in memory — a server
  restart loses them. A sweep every 5 minutes deletes finished jobs
  older than 30 minutes (or 10 minutes after the app fetched them).
  Jobs waiting on you (`paused-needs-user`) are never swept.
- **Context pool** (`lib/contexts.js`): up to **4 browser contexts at
  once** in the one Chromium instance. If 4 are already running, or
  free RAM drops below **150 MB**, the request is refused with 429
  instead of crashing the server. Contexts are always closed after use.
- **Session cookies** (`lib/sessions.js`): cookies are **per-request
  only**. The app sends them in the request
  (`cookies: [{name, value, domain, path, expires}]`); the server
  applies them to a fresh context, harvests the updated cookies, and
  returns them in the response. Cookies are **never stored on the
  server disk and never logged**. On the phone they are stored
  encrypted (Android Keystore AES/GCM) — see the app's
  `BrowserTakeover.kt`.
- **Stealth** (`lib/stealth.js`): every page gets a desktop-Chrome
  fingerprint (Chrome 120 on Windows 10, `Asia/Dhaka` timezone,
  `navigator.webdriver` hidden) and human-like typing. This helps with
  ordinary bot checks; it does not beat dedicated anti-bot systems
  (see Honest limits below).
- **CAPTCHA pause**: after navigation the worker sniffs the page title
  and visible text for challenge words (`captcha`, `verify you are
  human`, `just a moment`, …). On a match the job pauses
  (`paused-needs-user`) with a `takeoverUrl` and a BN+EN reason,
  instead of failing. The app opens that URL in its own WebView for
  you to solve, then resumes the job with the fresh cookies.

No new env vars: the pool (4 contexts, 150 MB floor) and job limits
(10 min, 20 jobs) are fixed in `lib/contexts.js` / `lib/jobQueue.js`.

### `POST /api/job` (auth) — also `POST /api/jobs`

Create a long job. Returns **202** `{"jobId": "..."}`. The app polls
`GET /api/job/:id` for the result.

```json
{
  "type": "browse",
  "url": "https://example.com/page",
  "cookies": [{"name": "session", "value": "YOUR_COOKIE_VALUE", "domain": "example.com"}]
}
```

`type` is one of `browse`, `read`, `screenshot`, `fill`, `download`:

- `browse` / `read` — open the URL, return visible text (max 20000
  chars) + title + final URL.
- `screenshot` — same page, plus a small cropped JPEG (see
  `/api/screenshot`).
- `fill` — fill a form; needs `fields` (array) — see `/api/fill`.
- `download` — capture the file the page downloads (max 8 MB); see
  Downloads below.

Optional fields: `selector` / `clip` (screenshot), `fields`,
`submit`, `allowPassword`, `checkoutApproved` (fill), `cookies` (all
types). Errors: 400 unknown type / bad URL / `fields` not an array;
429 too many jobs.

### `GET /api/job/:id` (auth) — also `GET /api/jobs/:id`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "browse",
  "status": "done",
  "progress": 100,
  "steps": [{"t": "2026-11-23T00:00:00.000Z", "text": "পাঠ্য পড়া হচ্ছে · Reading text…"}],
  "result": {"text": "...", "truncated": false, "title": "...", "url": "https://example.com/page", "cookies": []},
  "error": null,
  "createdAt": "...", "updatedAt": "...", "fetchedAt": "..."
}
```

`status`: `queued`, `running`, `done`, `failed`, `paused-needs-user`.
`result` depends on the type: `browse`/`read` →
`{text, truncated, title, url, cookies}`; `screenshot` →
`{jpegBase64, width, height, bytes, cookies}`; `fill` →
`{filledCount, notFound, url, cookies}`; `download` →
`{base64, filename, mime, size, cookies}` (or
`{tooLarge: true, size, filename}`, or `{notAFile: true, url}`). A
paused job's `result` is `{takeoverUrl, reason}`. 404 when the id is
unknown. Fetching a job marks it fetched (it is then swept 10 minutes
later).

`GET /api/jobs` (auth) lists all jobs as short summaries (no params,
no result payload).

### `POST /api/job/:id/resume` (auth)

Resume a paused job after the user solved the challenge in-app. Body:

```json
{"cookies": [{"name": "session", "value": "YOUR_COOKIE_VALUE", "domain": "example.com"}]}
```

Only a `paused-needs-user` job can be resumed (400 otherwise; 404 for
an unknown id). The job re-runs with its original params plus the
fresh cookies. Returns `{"ok": true, "status": "queued"}`.

### `POST /api/screenshot` (auth)

Synchronous (60 s timeout) small screenshot — no job needed:

```json
{"url": "https://example.com/page", "selector": ".price"}
```

Response:

```json
{"ok": true, "url": "https://example.com/page", "title": "...", "jpegBase64": "...", "width": 480, "height": 120, "bytes": 12345, "cookies": []}
```

Screenshots are small by design (`lib/screenshot.js`): cropped to the
requested element or region (never the full page), JPEG quality 50
(never above 60), at most 480 px wide; a full-viewport shot is capped
at 800×600 first. There is no downscaling library — an over-wide clip
is narrowed, not resized. 429 when the context pool is full / memory
is low; 504 after 60 s.

### `POST /api/fill` (auth)

Synchronous (60 s timeout) form fill:

```json
{
  "url": "https://example.com/form",
  "fields": [
    {"selector": "#name", "value": "Farid"},
    {"label": "Email", "value": "user@example.com"}
  ],
  "submit": false
}
```

Each field is located by selector, label text, name attribute, or
placeholder — in that order. Response:
`{"ok": true, "filledCount": 2, "notFound": [], "url": "https://example.com/form", "cookies": []}`.

Safety rules (`lib/formfill.js`) — these are not optional:

- **Password fields** are refused unless the field declares itself a
  password AND the request passes `allowPassword: true`.
- **Payment is never automatic.** If `submit` is true and the page
  contains a payment/card field, the submit is refused unless the
  request passes `checkoutApproved: true` — and even then the worker
  only fills and presses Enter; it **never clicks a button whose
  label means "pay"** (`pay`, `checkout`, `place order`, …). Checkout
  approval comes from the user in the app, never from the server.

### Downloads (job type `download`)

```json
{"type": "download", "url": "https://example.com/files/report.pdf"}
```

The worker navigates to the URL and captures the download: success
returns `{base64, filename, mime, size}` in the job result, so the app
can upload it to Firebase Storage and hand the user a share link;
files over **8 MB** return `{tooLarge: true, size, filename}`; a plain
page with no download in 20 s returns `{notAFile: true, url}`. The
temp file is always deleted on the server, whether the capture
succeeds or fails — the server never keeps the file.

### Keep-alive

Free hosts sleep or stop when idle, so a **free cron-job.org job**
pings `GET /health` **every 5 minutes** to keep the worker warm — no
auth needed for `/health`. Setup and how to check/stop it:
`docs/KEEP_ALIVE.md`.

**Honest cost note: keep-alive is not free.** A server that never
sleeps runs continuously, and Railway's ~$5 trial credit runs out
much faster that way. When the credit is gone the service stops until
you upgrade or move it (e.g. Render free tier). Turn the pinger off
when you are not using Nexus browsing for a while — see
`docs/KEEP_ALIVE.md` ("How to stop it"). Occasional use = no pinger
(first request then takes ~1 min to wake the server); regular use =
pinger on.

### Honest limits (browser upgrades)

- **Cloudflare Turnstile and bank sites may still block automation.**
  Challenge detection is a keyword sniff on the page title and
  visible text — a Turnstile widget often shows no such words, so the
  job may fail instead of pausing. There is **no paid CAPTCHA
  solver** anywhere: when a challenge is detected the job pauses and
  the page is handed to you in-app; Nexus never solves a CAPTCHA for
  you.
- **One Chromium, 512 MB**: at most 4 contexts at once — a 5th
  simultaneous page is refused (429 on the synchronous endpoints; a
  job fails with the same message). Jobs are in-memory only and are
  lost on restart.
- **Vision screenshots are small cropped JPEGs by design** (see
  `/api/screenshot`) — legibility, not beauty.
- Jobs time out after **10 minutes**; synchronous screenshot/fill
  calls after **60 s**.
- **No persistent login**: every request starts from the cookies the
  phone sends; the server stores nothing between requests.

## AI Studio build agent (server-side)

A separate agent that drives an **AI Studio build end-to-end on the
server** — it opens AI Studio, pastes your prompt, clicks Build, waits
for the build, fixes errors, and returns the result (app/preview URL).
Code: `lib/aistudio-agent.js` (the build-driving agent) + `server.js`
(the wiring: route, job, STOP). The old `/api/browse` path cannot do
this — it only opens a page and returns text; the agent is what
actually performs the build steps.

**Decided spec (2026-11-23).** Provider: **Google AI Studio (Gemini)**.
Primary model: **gemini-3.6-flash** — full flash, vision-capable, in the
verified free chain (distinct from the chat default
gemini-3.1-flash-lite).

**Dedicated key slots.** The agent runs on its **own** dedicated keys —
never the chat agents' keys and never Groq. Each agent keeps its own
provider/model, so one agent's quota running out never stops the
others. The user supplies the keys as server env vars (Railway/Render
**Variables**), and/or via an app Settings "Browser agent" key field
(app-side — the server just reads the env vars):

| Variable | Required | Notes |
|---|---|---|
| `BROWSER_AGENT_GEMINI_KEY` | **Yes, for builds** | The agent's **own dedicated Gemini key**. Without it, builds finish as `not-configured`. |
| `BROWSER_AGENT_OPENROUTER_KEY` | No | Its own dedicated key slot; enables the last failover leg only. |
| `BROWSER_AGENT_RPM_BUDGET` | No | Per-model RPM budget for the failover rotation (default 30/min per model). |

Never commit `.env` and never print a key. The server logs only the
agent LLM status (`configured` / `provider` / `model` / `chain` /
`openrouterConfigured`) at boot — no key value, ever.

**Failover chain** — inside the agent's **own** slots only, in fixed
order:

1. `gemini-3.6-flash` — key `BROWSER_AGENT_GEMINI_KEY`
2. `gemini-3.1-flash-lite` — same dedicated key
3. OpenRouter `qwen/qwen3-coder:free` — key
   `BROWSER_AGENT_OPENROUTER_KEY` (skipped when that key is unset)
4. Stop with a clear error.

**Failover rule** (same mechanics as the app's `ApiKeyFailoverManager`,
implemented in `lib/aistudio-agent.js`): per-model health tracking +
cooldown — on a 429 the failed model cools down and the next model is
tried, then the next provider. Each model/provider has its own
per-minute (RPM) budget (`BROWSER_AGENT_RPM_BUDGET`, default 30/min);
rotate **before** hitting the limit, and always honour `Retry-After`.

### `POST /api/agent/build` (auth)

Create a build job. Returns **202** `{"jobId": "..."}`. The app polls
`GET /api/job/:id` for the result (same job shape as `/api/job`).

```json
{
  "prompt": "Build a simple to-do app with a dark theme",
  "url": "https://aistudio.google.com/",
  "cookies": [{"name": "SID", "value": "YOUR_COOKIE_VALUE", "domain": ".google.com"}],
  "maxMinutes": 10,
  "fcmToken": "optional-device-token"
}
```

- `prompt` — **required**, non-empty string, max **8000** characters.
- `url` — optional, defaults to `https://aistudio.google.com/`; must be
  `http(s)` when given.
- `cookies` — optional array of session cookies (the phone's stored
  Google session, same shape as `/api/job`); applied to the build
  browser context and harvested back into the job result.
- `maxMinutes` — optional number, default **10**, clamped to **1–20**.
  The job timeout is `maxMinutes` + 2 minutes of agent overhead.
- `fcmToken` — optional string; the app is push-notified when the job
  finishes or pauses needing the user (same as other job types).

Errors: 400 bad input (BN+EN message); 429 too many jobs. There is
**no 503 when the agent LLM key is unconfigured** — the job is still
created and finishes fast with status `not-configured`, so the app
(and the dry-run check) sees a clear job record.

### Polling — `GET /api/job/:id` (auth)

Same as any other job. The build result is in `result`:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "aistudio-build",
  "status": "done",
  "progress": 100,
  "steps": [{"t": "...", "text": "Build started…"}],
  "result": {"ok": true, "status": "built", "appUrl": "https://...", "previewUrl": "https://...", "cookies": []},
  "error": null
}
```

`result.status` is one of `built`, `failed`, `login-required`,
`cancelled`, `timeout`, `not-configured`. `login-required` means the
Google session cookies were missing/expired — sign in again in the
app and retry with fresh cookies. `not-configured` means the server
has no `BROWSER_AGENT_GEMINI_KEY` set (see the dedicated-key table
above).

### STOP — `POST /api/job/:id/cancel` (auth)

Also `POST /api/jobs/:id/cancel`. Stops a queued, running, or paused
build job and returns `{"ok": true, "status": "cancelled"}`. The agent
checks for the cancel between steps and stops; the job stays
`cancelled` (never marked done/failed) and no push is sent. 404 for an
unknown id; 400 if the job is already terminal
(`done` / `failed` / `cancelled`).

## Calling it from the Nexus app (Kotlin / OkHttp)

```kotlin
// Settings stores: workerUrl (e.g. https://nexus-browser-worker.up.railway.app)
// and workerKey (the same BROWSER_WORKER_KEY value).
suspend fun browse(url: String, steps: List<Map<String, String>>): String =
    withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("url", url)
            .put("steps", JSONArray(steps.map { JSONObject(it) }))
            .toString()
        val req = Request.Builder()
            .url("$workerUrl/api/browse")
            .header("x-api-key", workerKey)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        okHttp.newCall(req).execute().use { res ->
            val json = JSONObject(res.body?.string() ?: "")
            if (!json.optBoolean("ok")) throw Exception(json.optString("error"))
            json.optString("text")
        }
    }
```

## Deploy — Railway (first choice; the user's bots already run there)

1. Push this folder as its own repo (or add it to a repo as a service rooted
   at this folder).
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo.
   Railway reads `railway.json` and builds the Dockerfile.
3. In the service **Variables**, set:
   - `BROWSER_WORKER_KEY` — generate one: `openssl rand -hex 32`
     (copy the same value into the Nexus app Settings).
   - Optional: `TASK_TIMEOUT_MS=60000`, `MAX_QUEUE=5`.
4. Railway gives the service a public URL
   (e.g. `https://nexus-browser-worker-production.up.railway.app`).
5. Test: `curl https://<your-url>/health` → `{"ok":true,"status":"up",...}`.
   Then test auth: `curl -X POST https://<your-url>/api/read -H "x-api-key: <key>" -H "Content-Type: application/json" -d '{"url":"https://example.com"}'`.

Note: Railway's trial has no card attached — when the trial credit runs out,
the service stops. Move to Render (below) if that happens.

## Deploy — Render (fallback, free tier)

1. Push this folder as its own repo.
2. In Render: **New → Web Service → pick the repo**. Render reads
   `render.yaml`: Docker, free plan, health check `/health`.
   `BROWSER_WORKER_KEY` is generated for you — **copy it** into the Nexus
   app Settings (the generated value is shown once in the dashboard).
3. Deploy. Test `/health` the same way as above.

## GitHub App connect (optional)

The Nexus app can connect to GitHub the way Meta Muse does — via a **GitHub
App installation** instead of a personal token. The app never sees the App's
private key: this server signs a JWT with it and mints a short-lived
installation access token (GitHub expires these within ~1 hour), scoped to
the repos the App is installed on.

### 1. Register the GitHub App

1. Go to https://github.com/settings/apps/new (as the account that owns the
   repos — e.g. `faridahmed6682-bussiness`).
2. **GitHub App name**: `Nexus AI` (any unique name works). **Homepage URL**:
   your Railway URL. **Webhook URL**:
   `https://<your-railway-url>/github/webhook` — **Active**, and set a
   **Webhook secret** (generate one: `openssl rand -hex 32`).
3. **Permissions** (Repository permissions):
   - **Contents**: Read and write (commits, files)
   - **Pull requests**: Read and write
   - **Issues**: Read and write
   - Metadata: Read-only (automatic).
4. **Where can this GitHub App be installed?** — "Only on this account".
5. Create the app, then on its settings page click **Generate a private
   key** — download the `.pem` file. Note the **App ID** at the top.
6. **Install** the App on the account (Install App → pick the account →
   choose All repositories or selected ones).

### 2. Set the env vars (Railway Variables)

| Variable | Value |
|---|---|
| `GITHUB_APP_ID` | The App ID (number) from the App settings page. |
| `GITHUB_APP_PRIVATE_KEY` | The whole `.pem` contents. Paste with real newlines, or as one line with literal `\n` — the server converts `\n` for you. |
| `GITHUB_WEBHOOK_SECRET` | The same webhook secret you set when registering the App. |

### 3. Endpoints

- `POST /github/webhook` — GitHub's webhook receiver. The HMAC SHA-256
  signature (`x-hub-signature-256`) is verified against
  `GITHUB_WEBHOOK_SECRET` over the raw body; bad signatures get 401. It
  records `installation` (created / deleted / new_permissions_accepted)
  and `installation_repositories` (added / removed) events. No `x-api-key`
  needed here — GitHub cannot send one; the signature is the auth.
- `GET /api/github/installations` (auth: `x-api-key`) — recorded
  installations + recent webhook events. An empty list means "no events
  seen yet", not "nothing is installed" (see limits below).
- `POST /api/github/installation-token` (auth: `x-api-key`) — body
  `{"installationId": 12345678}` → `{"ok":true,"token":"ghs_...","expiresAt":"...","installationId":12345678}`.
  The app then calls `api.github.com` with `Authorization: Bearer <token>`
  exactly as it would with a personal token. The token is never logged.

### 4. Calling it from the Nexus app (Kotlin / OkHttp)

```kotlin
// 1. Ask the worker for a token for the installation id the user picked.
val tokenJson = post("$workerUrl/api/github/installation-token",
    """{"installationId": $installationId}""", workerKey)
val token = JSONObject(tokenJson).getString("token")
// 2. Use it against api.github.com — e.g. list the repos the App can see:
val req = Request.Builder()
    .url("https://api.github.com/installation/repositories")
    .header("Authorization", "Bearer $token")
    .header("Accept", "application/vnd.github+json")
    .build()
```

Cache the token in the app until `expiresAt`, then request a fresh one —
never store the App private key on the phone.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | No | `3000` | Railway/Render set this themselves. |
| `BROWSER_WORKER_KEY` | **Yes** | — | Shared secret; without it `/api/*` returns 503. |
| `TASK_TIMEOUT_MS` | No | `60000` | Max time for one task. |
| `MAX_QUEUE` | No | `5` | Tasks waiting while one runs. |
| `GITHUB_APP_ID` | Only for GitHub App connect | — | App ID (number) from the GitHub App settings page. |
| `GITHUB_APP_PRIVATE_KEY` | Only for GitHub App connect | — | PEM private key; literal `\n` separators are converted. |
| `GITHUB_WEBHOOK_SECRET` | Only for GitHub App connect | — | Must match the secret set on the GitHub App. |
| `BROWSER_AGENT_GEMINI_KEY` | Only for AI Studio builds | — | Build agent's **own dedicated Gemini key** — never a chat agent's key. |
| `BROWSER_AGENT_OPENROUTER_KEY` | No | — | Build agent's own dedicated OpenRouter key (last failover leg). |
| `BROWSER_AGENT_RPM_BUDGET` | No | `30` | Build agent's per-model RPM budget for failover rotation. |

## Honest limits (free tiers)

- **Free servers sleep.** Render free sleeps after ~15 min idle (first call
  after sleep takes ~1 min to wake). Railway trial credit ends — then the
  service stops until you move it or add credit.
- **512 MB RAM is tight.** Chromium + one page fits, barely. Only one task
  runs at a time; a second task waits in the queue (429 if the queue is full).
- **Some sites block automation** (bot detection, CAPTCHA). There is no
  CAPTCHA-solving here — those tasks fail and the error is returned to the app.
- **No persistent login.** Each task starts logged out; logins must be
  scripted every time. Do not expect "stay logged in" behaviour.
- **Credentials pass through.** Login steps carry the password in the
  request. The worker never stores or logs credentials, but only use it for
  the user's own accounts, over HTTPS, and rotate passwords if a key leaks.
- **Screenshots are PNG base64** — a full-page shot can be large; the app
  should request screenshots only when it needs one.
- **File downloads (job type `download`).** A download job returns the
  file as base64 in the job result (max 8 MB; larger files are refused
  with `tooLarge`). The temp file is always deleted on the server.
- **GitHub installation state is ephemeral.** `github-installations.json`
  lives on the server's disk; on Railway/Render free plans the disk is wiped
  on redeploy/restart unless a volume is attached. If the list is empty
  after a restart, reinstalling or re-adding a repo sends a fresh webhook
  and re-records it. Installation tokens keep working regardless — they are
  minted from the App credentials, not from the recorded state.
- **Installation tokens expire within ~1 hour.** The app must request a
  fresh one (cheap, one API call) instead of storing it long-term.

## Files

| File | What it is |
|---|---|
| `server.js` | Express + Playwright server (all endpoints, queue, auth). |
| `lib/jobQueue.js` | Long jobs: 10-min timeout, max 20 in memory, pause/resume, sweep. |
| `lib/contexts.js` | Context pool: max 4 contexts, 150 MB free-RAM floor, 429 on refusal. |
| `lib/sessions.js` | Per-request cookies: apply to a fresh context, harvest back, never stored. |
| `lib/screenshot.js` | Small cropped JPEGs: quality 50 (max 60), max 480 px wide, 800×600 viewport cap. |
| `lib/formfill.js` | Form fill: password guard, payment guard (never clicks a pay button). |
| `lib/downloads.js` | File capture: base64 out, 8 MB max, temp file always deleted. |
| `lib/stealth.js` | Desktop-Chrome fingerprint + human-like mouse/typing. |
| `docs/KEEP_ALIVE.md` | Keep-alive with free cron-job.org (BN+EN) + honest credit note. |
| `package.json` | `express` + `playwright` (pinned 1.49.1, matching the image). |
| `Dockerfile` | Official Playwright image (`v1.49.1-jammy`), runs as `pwuser`. |
| `railway.json` | Railway: Dockerfile build, `/health` check, restart on failure. |
| `render.yaml` | Render: Docker web service, free plan, generated API key. |
| `.env.example` | Local-run env template (never commit a real `.env`). |
| `.gitignore` | Keeps `.env`, `github-installations.json` and `node_modules/` out of git. |
| `github-installations.json` | Runtime state (created on first webhook event, never committed). |

## Local check (no deploy, no browser install needed for a syntax check)

```bash
node --check server.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
# Smoke test (starts the HTTP server only; Chromium launches on first task):
BROWSER_WORKER_KEY=testkey PORT=3001 node server.js &
curl -s localhost:3001/health
curl -s -X POST localhost:3001/api/browse -H 'Content-Type: application/json' -d '{}'
# -> 401 (auth works). Kill the server afterwards.
```
