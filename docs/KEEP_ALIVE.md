# Keep-Alive — সার্ভার জাগিয়ে রাখা / Keeping the Server Awake

> **BN:** এই ডকুমেন্টে বলা আছে, Nexus browser worker সার্ভারটি কীভাবে সবসময়
> জেগে থাকে — যাতে Nexus অ্যাপ থেকে ব্রাউজিং কাজ পাঠালে সেটা সঙ্গে সঙ্গে শুরু হয়।
>
> **EN:** This document explains how to keep the Nexus browser worker server
> awake, so browsing jobs sent from the Nexus app start instantly.

## What keep-alive is — Keep-alive কী

**BN:** Railway-এর ফ্রি (trial) সার্ভিস কিছুক্ষণ কোনো রিকোয়েস্ট না পেলে ঘুমিয়ে
পড়ে (sleep)। ঘুমন্ত সার্ভারকে প্রথম রিকোয়েস্টে জাগাতে প্রায় ১ মিনিট সময় লাগে।
Keep-alive মানে: প্রতি ৫ মিনিটে একবার সার্ভারের `/health` ঠিকানায় একটা হালকা
ping পাঠানো, যাতে সার্ভার কখনো ঘুমাতে না পারে। ফলে Nexus থেকে ব্রাউজিং কাজ
পাঠালেই সঙ্গে সঙ্গে শুরু হয় — কোনো অপেক্ষা নেই।

**EN:** Railway's free (trial) services go to sleep after a period with no
requests. Waking a sleeping server takes about 1 minute on the first request.
Keep-alive means sending one light ping to the server's `/health` address
every 5 minutes, so the server never falls asleep. Browsing jobs from Nexus
then start instantly — no waiting.

## Why `/health` is the right ping — কেন `/health`-এ ping করবেন

**BN:** `/health` হলো সবচেয়ে হালকা endpoint। এটি Chromium চালু করে না, কোনো
ব্রাউজার কাজ করে না, এবং কোনো API key লাগে না — শুধু সার্ভার বেঁচে আছে কি না
তা জানায়। তাই প্রতি ৫ মিনিটে ping করলেও সার্ভারের উপর প্রায় কোনো চাপ পড়ে না।

**EN:** `/health` is the lightest endpoint. It does not launch Chromium, does
no browser work, and needs no API key — it only reports that the server is
alive. So pinging it every 5 minutes puts almost no load on the server.

```json
{"ok":true,"status":"up","browser":"idle","queuedTasks":0,"uptimeSec":123}
```

> **BN:** প্রমাণ: `server.js`-এ `/health` রুটে কোনো auth নেই এবং কোনো
> `chromium.launch()` কল নেই — শুধু মেমোরিতে থাকা মানগুলো (`browser`,
> `queueLength`, `uptimeSec`) পড়ে উত্তর দেয়।
>
> **EN:** Proof: in `server.js` the `/health` route has no auth and no
> `chromium.launch()` call — it only reads values already in memory
> (`browser`, `queueLength`, `uptimeSec`) and answers.

## ⚠️ Honest cost note — খরচের সত্যি কথা (আগে পড়ুন)

**BN:** Keep-alive **ফ্রি নয়** — এটি Railway trial credit খরচ করে। সার্ভার
কখনো না ঘুমালে সেটি সারাক্ষণ চলতে থাকে, আর Railway-এর প্রায় **$5 trial
credit অনেক তাড়াতাড়ি শেষ হয়ে যায়**। Credit শেষ হলে সার্ভিস বন্ধ হয়ে যাবে
— যতক্ষণ না আপনি upgrade করেন বা অন্য হোস্টে (যেমন Render free tier) সরিয়ে
নেন।

**তাই: Nexus browsing কিছুদিন ব্যবহার না করলে pinger বন্ধ করে দিন।** নিচে
"How to stop it" দেখুন। শুধু তখনই keep-alive চালু রাখুন, যখন আপনি নিয়মিত
Nexus দিয়ে ব্রাউজিং করছেন।

**EN:** Keep-alive is **not free** — it spends Railway trial credit. A server
that never sleeps runs continuously, and Railway's ~**$5 trial credit runs
out much faster** that way. When the credit is gone, the service stops until
you upgrade or move to another host (such as Render's free tier).

**So: turn the pinger OFF when you are not using Nexus browsing for a
while.** See "How to stop it" below. Keep keep-alive on only while you are
regularly browsing through Nexus.

## Free setup with cron-job.org — ফ্রি সেটআপ (কোনো কার্ড লাগে না)

[cron-job.org](https://cron-job.org) একটি ফ্রি সার্ভিস — প্রতি ৫ মিনিটে আপনার
সার্ভারে ping পাঠায়। কোনো ক্রেডিট কার্ড লাগে না।

**BN — ধাপে ধাপে:**

1. [cron-job.org](https://cron-job.org)-এ যান এবং **ফ্রি অ্যাকাউন্ট** খুলুন
   (Sign up — শুধু ইমেইল লাগে)।
2. লগইন করে **Dashboard → Create cronjob**-এ ক্লিক করুন।
3. **Title**-এ লিখুন: `Nexus browser worker keep-alive` (নামটা যেকোনো হতে পারে)।
4. **URL**-এ বসান আপনার Railway ঠিকানা + `/health`, যেমন:
   `https://<your-railway-url>/health`
   (আপনার আসল URL-টি Railway dashboard-এ পাবেন; README-র Deploy অংশ দেখুন।)
5. **Schedule**-এ বেছে নিন **every 5 minutes**।
6. **Request method**: `GET`।
7. **কোনো auth / API key দেবেন না** — `/health`-এ auth লাগে না। (শুধু `/api/*`
   endpoint-গুলোতে `x-api-key` লাগে; keep-alive ping-এ সেটা দরকার নেই।)
8. **Create** চাপুন। ব্যস — এখন থেকে প্রতি ৫ মিনিটে একবার ping যাবে।

**EN — step by step:**

1. Go to [cron-job.org](https://cron-job.org) and create a **free account**
   (sign up — only an email is needed).
2. Log in and click **Dashboard → Create cronjob**.
3. **Title**: `Nexus browser worker keep-alive` (any name works).
4. **URL**: your Railway address + `/health`, e.g.
   `https://<your-railway-url>/health`
   (find your real URL in the Railway dashboard; see the Deploy section of
   the README).
5. **Schedule**: **every 5 minutes**.
6. **Request method**: `GET`.
7. **Do not add any auth / API key** — `/health` needs no auth. (Only the
   `/api/*` endpoints need `x-api-key`; the keep-alive ping does not.)
8. Click **Create**. Done — a ping now goes out every 5 minutes.

> **BN:** উদাহরণ কনফিগ: `docs/keep-alive-cron-example.json` — আসল URL নয়,
> শুধু উদাহরণ; আপনার নিজের Railway URL বসিয়ে নিন।
>
> **EN:** Example config: `docs/keep-alive-cron-example.json` — placeholder
> only, not a real URL; put in your own Railway URL.

## How to check it works — কাজ করছে কি না যাচাই

**BN:**

1. ব্রাউজারে `https://<your-railway-url>/health` খুলুন — `{"ok":true,...}`
   দেখালে সার্ভার চলছে (200 OK)।
2. Railway dashboard-এ আপনার সার্ভিসের **Logs** খুলুন — প্রতি ৫ মিনিটে
   একটা করে `GET /health 200` লাইন দেখতে পাবেন। এই লাইনগুলোই প্রমাণ যে
   pinger কাজ করছে।
3. cron-job.org-এর Dashboard-এ job-টির **History / Last run**-এ সবুজ
   (success, HTTP 200) দেখা যাবে।

**EN:**

1. Open `https://<your-railway-url>/health` in a browser — seeing
   `{"ok":true,...}` means the server is up (200 OK).
2. Open your service's **Logs** in the Railway dashboard — you should see
   one `GET /health 200` line every 5 minutes. Those lines are the proof
   the pinger is working.
3. In the cron-job.org dashboard, the job's **History / Last run** should
   show green (success, HTTP 200).

> **BN:** লগে শুধু `GET /health` দেখা যাওয়ার মানে সার্ভার শুধু "জেগে আছে" —
> এতে কোনো ব্রাউজার কাজ হয় না, কোনো খরচের কাজ চলে না। লগে `GET /health`
> দেখা গেলেই keep-alive ঠিক আছে।
>
> **EN:** Seeing only `GET /health` in the logs means the server is just
> "staying awake" — no browser work runs and no costly work happens. If
> `GET /health` appears, keep-alive is fine.

## How to stop it — বন্ধ করবেন যেভাবে

**BN:** Nexus browsing কিছুদিন ব্যবহার না করলে — অথবা Railway credit বাঁচাতে
চাইলে — pinger বন্ধ করুন:

1. [cron-job.org](https://cron-job.org)-এ লগইন করুন।
2. Dashboard-এ `Nexus browser worker keep-alive` job-টি খুঁজুন।
3. **Disable** চাপুন (পরে আবার চালু করতে পারবেন), অথবা **Delete** চাপুন
   (একেবারে মুছে ফেলতে)।
4. Railway Logs-এ আর `GET /health` আসা বন্ধ হয়েছে কি না দেখে নিন।

**EN:** If you will not use Nexus browsing for a while — or want to save
Railway credit — stop the pinger:

1. Log in to [cron-job.org](https://cron-job.org).
2. Find the `Nexus browser worker keep-alive` job in the dashboard.
3. Click **Disable** (you can turn it back on later) or **Delete** (to
   remove it entirely).
4. Check the Railway logs to confirm `GET /health` entries have stopped.

## Alternative: no pinger at all — বিকল্প: pinger ছাড়াই চালানো

**BN:** Pinger ছাড়াও চলবে — এটাই ফ্রি উপায়। সার্ভার ঘুমিয়ে পড়বে, আর প্রথম
রিকোয়েস্টে জাগতে প্রায় **১ মিনিট** লাগবে। তারপর আবার স্বাভাবিকভাবে চলবে।
মাঝে মাঝে ব্রাউজিং করলে এই ১ মিনিটের অপেক্ষা একদম ঠিক আছে — এতে Railway
credit বাঁচে। তাই: **মাঝে মাঝে ব্যবহার = pinger নয়; নিয়মিত ব্যবহার =
pinger চালু।**

**EN:** It also works without a pinger — and that is the free way. The
server will sleep, and the first request will take about **1 minute** to
wake it. After that it runs normally again. For occasional browsing that
1-minute wait is perfectly fine — and it saves Railway credit. So:
**occasional use = no pinger; regular use = pinger on.**

## Files

| File | What it is |
|---|---|
| `docs/KEEP_ALIVE.md` | This document (BN + EN). |
| `docs/keep-alive-cron-example.json` | Example cron-job.org job config (placeholders only). |
