# 📸 SayTheWord (ManyChat-style, on Cloudflare)

Your own comment-to-DM automation for Instagram reels, running 24/7 on **Cloudflare Workers** — no laptop required.

```
Someone comments "LINK" on your reel
        │
        ▼
1. Public comment reply  (rotates 3 short replies)
        │
        ▼
2. Private reply DM      ("Send me the link 🔗" button)
        │                    (Instagram allows ONE private reply per comment)
        ▼  they tap
3. Follow gate           ("I'm following" button if needed)
        │
        ▼  optional
4. Email step            ("Drop your email…", skippable — captured to CSV)
        │
        ▼
5. Link delivered        (tracked: /go/… → your URL)
        │
        ▼  no tap after 1 hour?
6. ONE follow-up nudge   (cron, every minute)
```

Everything is stored in a **SQLite Durable Object**, webhooks are authenticated with **X-Hub-Signature-256**, and the bot stays in **dry-run** (processes everything, sends nothing) until you connect your Instagram token.

---

## Features

- **One automation per reel** — pick the reel from your recent posts, set keywords, public replies, DM text, and the link.
- **Or "my next reel" mode** — the automation waits unattached and claims the **first new reel that gets a matching keyword comment**, then runs there from then on. Reels published before you saved it are skipped (checked via the reel's publish time), so an old post can't hijack it.
- **Keyword matching** — `contains` or `exact`, case-insensitive; once per user per reel.
- **Follow gate** — Instagram's API can check `is_user_follow_business` when Meta grants your app the capability; otherwise users get the honor-system "I'm following" button (configurable per automation).
- **Email step (optional)** — after the follow gate, ask for their email before the link. They reply by typing it, or tap a skippable "Skip, send the link" button. Addresses are stored on the contact and export as **CSV** (Contacts → Download CSV). The funnel counts how many gave one.
- **DM earlier comments (catch-up)** — one click on a saved automation DMs everyone who commented a keyword on that reel **in the last 7 days** (Instagram's private-reply window) and hasn't received the link yet. Reads the reel's real comments, runs the normal flow per user, paced and capped at 50 per run. Live mode only.
- **Tracked link clicks** — the link button routes through your Worker (`/go/<signed-token>`) and redirects, so the funnel counts real clicks.
- **One-time follow-up** — scheduled 60 min after the DM (configurable), cancelled the moment they tap.
- **Weekly token refresh** — long-lived Instagram tokens last 60 days; the cron refreshes them every ~6 days.
- **Admin console** (`/admin`) — phone preview of every DM, funnel (commented → DM → tapped → link → clicked), contacts, activity log, dry-run test button.
- **`/privacy` and `/data-deletion`** pages for Meta app review, plus in-DM `delete my data` self-service.
- **Dry-run mode** — full pipeline runs, zero messages sent, until a token is connected.

## Stack

| Piece                                                    | Where                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| Worker (routes, webhook auth, admin, OAuth, cron)        | `src/index.ts`                                                   |
| Durable Object `BotStore` (SQL state, flow logic, sends) | `src/do.ts`                                                      |
| Graph API client (graph.instagram.com)                   | `src/graph.ts`                                                   |
| Admin UI                                                 | `src/admin.html`                                                 |
| Public pages                                             | `src/landing.html`, `src/privacy.html`, `src/data-deletion.html` |
| Local end-to-end tests                                   | `scripts/local-test.mjs`                                         |

---

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars     # local dev secrets (gitignored)

npm run deploy                     # deploys to Cloudflare (asks you to log in on first run)
```

Then set production secrets — **keys live in Cloudflare's secret store, never in code**:

```bash
npx wrangler secret put APP_SECRET          # Meta App Secret (webhook signatures, admin session, link tokens)
npx wrangler secret put ADMIN_PASSWORD      # your /admin password
npx wrangler secret put WEBHOOK_VERIFY_TOKEN # any random string; same one you paste into Meta
```

Open `https://saytheword.<your-subdomain>.workers.dev/admin`, sign in, and continue with the Meta setup below.

> Local dev: `npm run dev` → http://127.0.0.1:8787 (`.dev.vars` supplies the secrets). Tests: `npm run test:local` (needs the dev server running; it exercises the whole funnel in dry-run).

---

## Meta app setup — step by step

### Step 0 — Prerequisites

1. Your Instagram account must be a **professional account** (Creator or Business): Instagram app → _Settings → Account type and tools → Switch to professional account_.
2. A **Cloudflare account** (free plan is fine) and Node 18+.
3. A Meta developer account at [developers.facebook.com](https://developers.facebook.com) — log in with your Facebook account.

### Step 1 — Create the app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App**.
2. Pick the **Instagram Platform** / "manage everything on your Instagram account" use case (this gives you _Instagram API with Instagram Login_ — the `graph.instagram.com` flavor this bot uses).
3. Name it (e.g. "Comment to DM"), create it.

### Step 2 — Copy your credentials

1. In the app dashboard go to **App settings → Basic**.
2. Copy **App ID** and **App Secret**.
3. Run the three `wrangler secret put …` commands from Quick start (paste the App Secret for `APP_SECRET`). Keep the App ID for Step 6.

### Step 3 — Deploy the Worker (if you haven't)

```bash
npm run deploy
```

Note your URL: `https://saytheword.<subdomain>.workers.dev`. Every setting below uses it.

### Step 4 — Add the webhook callback

1. In the app dashboard open the **Instagram** product → **Webhooks** (or _Webhooks_ with object _Instagram_).
2. **Callback URL**: `https://saytheword.<subdomain>.workers.dev/webhook`
3. **Verify token**: the exact value of your `WEBHOOK_VERIFY_TOKEN` secret.
4. Click **Verify and save** — Meta calls `GET /webhook` and expects the challenge echo back (the bot handles this).
5. Subscribe to these **fields**: `comments`, `messages`, `messaging_postbacks`.

### Step 5 — Add the OAuth redirect URI

1. App dashboard → **Instagram → Settings** (or _App settings → Authorization_) → **OAuth redirect URIs** / _Client OAuth settings_.
2. Add: `https://saytheword.<subdomain>.workers.dev/auth/callback`

### Step 6 — Connect your Instagram account

1. Open your Worker's `/admin` → **Settings** tab.
2. Paste your **App ID** into _Meta App ID_ and save (this enables the one-click connect button).
3. Click **Connect Instagram account** → log in → authorize the three scopes:
   - `instagram_business_basic`
   - `instagram_business_manage_comments`
   - `instagram_business_manage_messages`
4. You land back on the admin console with a 🟢 **LIVE** badge. The 60-day token is stored in the Durable Object (server-side only) and refreshed weekly by the cron.

   _(No OAuth handy? Settings also accepts a manually pasted long-lived token.)_

### Step 7 — Create your first automation

1. **Automations → ＋ New automation** → _Browse my reels_ → pick one.
2. Add keywords (e.g. `LINK`, `send`), tweak the three reply lines, DM text, and paste your **link URL** (https).
3. Keep _Ask them to follow first_ on if you want the follow gate. Watch the phone preview update live. **Save**.
4. Click **Run dry-run test** — the whole funnel is simulated and appears in the **Activity** tab. Nothing is sent.

### Step 8 — Test for real

1. Comment a keyword on the reel from another account (or ask a friend).
2. Watch the **Activity** tab: `commented → comment_replied → dm_sent → postback → …`.
3. In the follower's Instagram: they got a comment reply + a DM with your button. Tapping it walks them through the gate and the link.

### Step 9 — App Review (only if others must use it / Meta asks)

If the app is only for **your own account**, Development mode is enough — webhooks and messaging work for app admins/testers. To publish the app for other businesses (or to unlock some capabilities), Meta requires:

1. **Privacy Policy URL**: `https://<your-worker>.workers.dev/privacy` (already hosted ✓)
2. **Data deletion**: `https://<your-worker>.workers.dev/data-deletion` (already hosted ✓ — it also explains the in-DM `delete my data` flow)
3. **Screencast**: show a user commenting the keyword → receiving the public reply + private DM → tapping the button → receiving the link. Show the admin console too.
4. Request the three `instagram_business_*` permissions under **App Review → Permissions and Features**.

---

## Configuration reference

| Secret / setting       | Where                              | Purpose                                                                                                            |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `APP_SECRET`           | wrangler secret                    | Verifies `X-Hub-Signature-256` on every webhook; signs admin sessions and `/go/` link tokens; OAuth client secret. |
| `ADMIN_PASSWORD`       | wrangler secret                    | `/admin` login (rate-limited: 5 fails → 15 min lock).                                                              |
| `WEBHOOK_VERIFY_TOKEN` | wrangler secret                    | Meta webhook verification handshake.                                                                               |
| Instagram token        | Durable Object (via OAuth / admin) | Long-lived, auto-refreshed weekly. Never in code.                                                                  |
| Meta App ID            | admin → Settings                   | Enables the OAuth connect button (public info).                                                                    |
| Nudge delay            | admin → Settings                   | Follow-up delay in minutes (default 60).                                                                           |
| Public URL             | admin → Settings                   | Origin used in tracked links (defaults to your workers.dev URL).                                                   |
| Graph version          | admin → Settings                   | Defaults to `v26.0`.                                                                                               |

## Local development & testing

```bash
npm run dev          # http://127.0.0.1:8787  (uses .dev.vars)
npm run typecheck    # tsc --noEmit
npm run test:local   # 65-assertion end-to-end suite (server must be running)
```

The test suite covers: webhook verification + signature rejection, admin auth, automation validation, the full comment → DM → gate → email → link → click funnel (dry-run), next-reel attaching, the email step + CSV export, one-time nudges via `__scheduled`, and the test-data tools. It's idempotent — rerun freely.

## Limits & gotchas (read this once)

- **One private reply per comment** — Instagram enforces this hard. The DM (message + button) is a single message; if it fails, that comment can't be retried (the log shows `dm_failed`).
- **24-hour messaging window** — after your private reply, you can only message a user again within 24h of _their_ last interaction. That's why the follow-up nudge only reaches people who tapped something; for silent users the API rejects it and the log records `nudge_failed` (this is Meta policy, not a bug).
- **Private replies expire 7 days** after the comment. That's also why _DM earlier comments_ only targets comments from the last 7 days — older comments can't be privately replied to.
- **Catch-up sends are real** — the button DMs actual users. Double-check keywords before running it, and note Instagram rate limits: it paces 250 ms between users and caps at 50 per run.
- **"My next reel" attaches on the first match** — the first reel that receives a matching comment claims the automation. If it attaches to the wrong reel, delete or edit the automation and switch Trigger back to _my next reel_ (re-arming it skips reels older than the moment you saved).
- **Follow check** — `is_user_follow_business` is only returned when Meta grants your app the capability. Otherwise the bot asks everyone and trusts the "I'm following" button (standard practice for API-based tools).
- **Button text ≤ 20 chars**, DM text ≤ 640 chars (button template), enforced in the UI/API.
- **Funnel includes dry-run/test activity** — use _Clear test data_ / _Reset all activity data_ in Settings → Maintenance before judging real numbers.
- **Rotating replies** are picked deterministically per comment (hash), so webhook redeliveries never double-reply — and the same comment is always answered with the same reply.

## Troubleshooting

| Symptom                         | Fix                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook "Verify and save" fails | Callback URL must be exact (`/webhook`), and `WEBHOOK_VERIFY_TOKEN` must match the secret. Check the URL is deployed first.                              |
| 403 in logs for webhook POSTs   | `APP_SECRET` doesn't match the app you configured. Re-run `npx wrangler secret put APP_SECRET`.                                                          |
| `comment_ignored` in Activity   | No enabled automation for that reel's media ID — check the ID in the automation editor.                                                                  |
| `dm_failed` / `nudge_failed`    | Open the detail: usually the 24h window (nudge) or messaging permission missing (app review / scope).                                                    |
| No DMs arriving at all          | Bot in dry-run? Badge in header. Token connected but _live_mode_ off? Settings. Reel is a professional account? Webhooks subscribed to all three fields? |
| Admin login loops               | Cookie needs HTTPS — open the deployed https:// URL, not http.                                                                                           |
| Token expired (~60 days)        | Weekly cron normally prevents this; if you see `token_refresh_failed`, reconnect in Settings.                                                            |
