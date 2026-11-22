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

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | No | `3000` | Railway/Render set this themselves. |
| `BROWSER_WORKER_KEY` | **Yes** | — | Shared secret; without it `/api/*` returns 503. |
| `TASK_TIMEOUT_MS` | No | `60000` | Max time for one task. |
| `MAX_QUEUE` | No | `5` | Tasks waiting while one runs. |

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
- **No file downloads.** The worker returns page text and screenshots only;
  downloading files to the phone is not implemented.

## Files

| File | What it is |
|---|---|
| `server.js` | Express + Playwright server (all endpoints, queue, auth). |
| `package.json` | `express` + `playwright` (pinned 1.49.1, matching the image). |
| `Dockerfile` | Official Playwright image (`v1.49.1-jammy`), runs as `pwuser`. |
| `railway.json` | Railway: Dockerfile build, `/health` check, restart on failure. |
| `render.yaml` | Render: Docker web service, free plan, generated API key. |
| `.env.example` | Local-run env template (never commit a real `.env`). |

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
