# corex hosting — backend

## Quickstart (Docker — the reliable way to run this)

If hosting this has been breaking on you, this is the fix: Docker packages
the exact runtime this needs (Node, Python, correct versions) into one
image, so it behaves identically on your machine, a VPS, or Railway —
no more "works locally, breaks on the server" from OneDrive interference,
a forgotten `npm install`, or a Node version mismatch.

```bash
docker build -t corex-hosting .
docker run -d -p 4000:4000 --env-file .env \
  -v corex-data:/app/data -v corex-bots:/app/bots \
  --name corex corex-hosting
```

That's it — `http://localhost:4000` is live, and `-v corex-data` /
`-v corex-bots` keep your accounts and hosted bots even if you rebuild
the image later. `docker logs -f corex` shows the config status report
right after it starts, telling you exactly what's on and what still
needs an env var. To deploy this same image on a VPS, `railway up` (it
auto-detects the Dockerfile), or any other Docker-friendly host, the
command is identical — that consistency is the entire point.

Don't have Docker / prefer running it directly? `npm install && npm
start` still works exactly as before — see below.

This is the piece that actually keeps uploaded Discord bots running. It's a
small Node.js API that:

- accepts a zipped bot (`POST /api/bots`)
- installs its dependencies (`npm install` / `pip install`)
- runs it as its own process
- **automatically restarts it if it crashes**, with backoff
- streams its console output live (`GET /api/bots/:id/logs/stream`)

Your landing page (the HTML file) talks to this API over HTTP. The page
itself never keeps anything alive — this server does, which is why it has
to run somewhere that stays on: a VPS, a small cloud box, a Raspberry Pi
sitting in a closet, whatever you've got.

## Running it

Your landing page is bundled in `public/index.html` and served
automatically — once the server's running, open `http://localhost:4000`
(or your domain) and you'll get the site itself, with the API living
alongside it at `/api/*`.

A secret API key has already been generated for you in `.env`
(`COREX_API_KEY`) — the server loads it automatically, so you don't need to
set anything by hand:

```bash
npm install
npm start
```

That key is your password for `/api/*` — keep the `.env` file private
(don't commit it to a public repo), and every request you make to the API
needs to include it as a header: `x-api-key: <the value from .env>`.
Want a different one later, just edit `.env` and restart the server.

Every request needs an `x-api-key` header matching `COREX_API_KEY`, or it's
rejected. **Change the default key before you expose this to the internet.**

To keep the *manager itself* alive 24/7 (separate from the bots it hosts),
run it under a process supervisor:

```bash
npm install -g pm2
pm2 start server.js --name corex-backend
pm2 save
pm2 startup   # follow the printed instructions so it survives a reboot
```

## API quick reference

| Method | Path | What it does |
|---|---|---|
| GET | `/api/bots` | list all bots + live status |
| POST | `/api/bots` | upload a new bot (`multipart/form-data`: `name`, `runtime` = `node`\|`python`, `file` = zip) |
| POST | `/api/bots/:id/start` | start it |
| POST | `/api/bots/:id/stop` | stop it (won't auto-restart until started again) |
| POST | `/api/bots/:id/restart` | restart it |
| POST | `/api/bots/:id/env` | set env vars as JSON body, e.g. `{ "DISCORD_TOKEN": "..." }` |
| GET | `/api/bots/:id/logs` | recent log lines |
| GET | `/api/bots/:id/logs/stream` | live log stream (Server-Sent Events) |
| DELETE | `/api/bots/:id` | stop and delete a bot |

A Node bot needs an `index.js` (or a `main` field in its `package.json`).
A Python bot needs `main.py` or `bot.py`, plus a `requirements.txt` if it
has dependencies.

## Turning on the £1 premium payment

The site already has the full payment flow built — a real "Upgrade to
Premium" button, a Stripe-hosted checkout page, a webhook that unlocks
premium the moment payment clears, and a sales list in the admin
dashboard. It's just switched off until you add your own Stripe keys to
`.env`. It never touches card numbers itself — Stripe's hosted checkout
page handles that part, which is what keeps this both simple and legal to
run.

1. Create a free account at https://dashboard.stripe.com and finish their
   verification (this is also where you add the bank account your payouts
   go to — under Settings → Payouts. Nothing card-related is stored on
   this server).
2. **Get your secret key**: Developers → API keys → copy the "Secret key"
   → paste it into `.env` as `STRIPE_SECRET_KEY`.
3. **Create the £1 product**: Product catalog → Add product → name it
   "corex premium" → price £1.00, one-time → save → copy the **Price ID**
   (starts with `price_`) → paste into `.env` as `STRIPE_PRICE_ID`.
4. **Set up the webhook**: Developers → Webhooks → Add endpoint → URL is
   `https://yourdomain.com/api/premium/webhook` (this has to be a real
   public HTTPS URL, so this step needs your server actually deployed
   somewhere reachable, not just `localhost` — use the Stripe CLI's
   `stripe listen --forward-to localhost:4000/api/premium/webhook` to test
   locally first) → select the `checkout.session.completed` event → copy
   the **Signing secret** (starts with `whsec_`) → paste into `.env` as
   `STRIPE_WEBHOOK_SECRET`.
5. `npm install` (pulls in the `stripe` package) → restart the server.

That's it — the "Upgrade to Premium" button in the dashboard starts
working the moment those three values are filled in. Until then, clicking
it just tells the visitor payments aren't set up yet.



This version runs uploaded code as a plain OS process — enough to prove the
concept and host your own bots, but **not safe to open up to the public
yet**, because any uploaded bot can see and touch the same machine the API
runs on. Before onboarding other people's bots:

1. **Isolate each bot in its own container.** Run each bot inside Docker
   (or gVisor/Firecracker for stronger isolation) with CPU/memory limits,
   instead of spawning it directly as a process. This is the single most
   important upgrade.
2. **Limit what a bot's process can do** — no access to the host
   filesystem outside its own folder, no ability to reach your database or
   other bots' env vars.
3. **Cap resources per bot** (CPU, RAM, disk, network) so one bot can't
   starve the others or run up your bandwidth bill.
4. **Scan uploads** before extracting them (file type, zip-bomb size
   checks, no path traversal in filenames).
5. **Real per-user auth**, not a single shared API key — tie each bot to
   the account that owns it, and check that on every request.
6. **Rate-limit uploads and restarts** so the API itself can't be used to
   hammer the host machine.

None of that is exotic — it's the same shape as what Heroku-style
platforms do — but it's a real chunk of work, and worth doing before
anyone besides you is uploading code to this. Happy to help build the
Docker version next if you want to take it there.

## Turning on "Continue with Discord"

1. Go to https://discord.com/developers/applications → New Application →
   name it whatever you want.
2. **OAuth2** in the sidebar → copy the **Client ID** and **Client Secret**
   → paste into `.env` as `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
3. Still on the OAuth2 page → **Redirects** → add:
   `https://yourdomain.com/api/auth/discord/callback` (or
   `http://localhost:4000/api/auth/discord/callback` while testing locally)
   — this has to match exactly what the server sends, or Discord will
   reject the login.
4. `npm install` if you haven't already → restart the server.

The "Continue with Discord" button in the login modal starts working
immediately once those two keys are filled in.

## Turning on "Continue with Google"

1. https://console.cloud.google.com/apis/credentials → create a project if
   you don't have one → **Create Credentials → OAuth client ID**.
2. If prompted, configure the consent screen first (External, fill in the
   basics — this doesn't need Google's review for a small number of users
   in testing mode).
3. Application type: **Web application**. Under **Authorized redirect
   URIs**, add `https://yourdomain.com/api/auth/google/callback` (or
   `http://localhost:4000/api/auth/google/callback` while testing locally).
4. Copy the **Client ID** and **Client Secret** → paste into `.env` as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Restart the server.

## Turning on "Continue with GitHub"

1. https://github.com/settings/developers → **OAuth Apps → New OAuth App**.
2. **Authorization callback URL**: `https://yourdomain.com/api/auth/github/callback`
   (or `http://localhost:4000/api/auth/github/callback` while testing
   locally) — GitHub only allows one callback URL per app, so use a
   second app if you need both local and production working at once.
3. Copy the **Client ID**, generate a **Client Secret**, and paste both
   into `.env` as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
4. Restart the server.

Both buttons work the same way as Discord's — first-time login creates
the account (checked against the one-account-per-IP rule), returning
users just log in.

## Sending the Discord welcome email

When someone signs up for the first time via Discord, the server can send
them a short welcome email — this uses plain SMTP so it works with almost
any provider:

- **Gmail**: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER` = your
  Gmail address, `SMTP_PASS` = an **App Password** (not your normal
  password — generate one at https://myaccount.google.com/apppasswords,
  requires 2FA turned on).
- **Resend / Postmark / etc**: they each give you an SMTP host, a
  username, and a password/API key on their dashboard — same four fields.

Fill in `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` in `.env`,
`npm install`, restart. If `SMTP_HOST` is left blank, the app just skips
sending the email and logs a note in the console — nothing breaks.

Note: this only fires for Discord logins, since that's the one place this
app actually has a verified email address (it asks Discord for the
`email` scope). The plain username/password signup form doesn't collect
an email at all.

## One account per IP, and banning by IP

Every signup (Discord or username/password) is checked server-side
against the IP it came from — if that IP already has an account, the
signup is rejected. The admin dashboard has a **Signups by IP** table
showing every IP and which account(s) came from it, with a **Ban IP**
button. Banning a user from the main accounts table now also bans their
IP automatically, so they can't just make a new account from the same
connection.

Worth knowing honestly: IP-based limits are a real deterrent, not a hard
wall. VPNs and mobile data let someone get a new IP in seconds, and the
reverse is also true — people on the same shared IP (university wifi,
an office, some ISPs' carrier-grade NAT) can get incorrectly blocked from
each other's genuine signups. It raises the bar for casual abuse; it
won't stop someone determined to make multiple accounts.



This app is a normal always-on Node server, which is exactly what Railway
runs (unlike Vercel, which can't keep a process alive — it kills your code
between requests and has no persistent disk). Fastest path, using their
CLI straight from this folder:

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Then add your environment variables (the same ones in your local `.env`)
either via `railway variables set COREX_API_KEY=...` for each one, or in
the Railway dashboard under your project → Variables. Once it's deployed,
run `railway domain` to get a public URL — that's what you register as
your Discord redirect URI and Stripe webhook URL.

**Important**: by default, anything written to disk (uploaded bots, the
accounts/premium/sales JSON files) is wiped on every redeploy on most
hosts, Railway included, unless you attach persistent storage. In the
Railway dashboard, add a **Volume** to the service and mount it at `/app`
(or specifically at `/app/bots` and `/app/data`) so your bots and records
survive restarts and redeploys.

## Setting up the Discord bot

This is a separate bot from the "Continue with Discord" login above — this
one lives in your server as **two persistent panels** rather than
commands, plus member/ban tracking.

1. https://discord.com/developers/applications → your app (or a new one) →
   **Bot** tab → Reset Token → paste into `.env` as `DISCORD_BOT_TOKEN`.
2. Same Bot tab → turn on **Server Members Intent** (join/leave tracking)
   AND **Message Content Intent** (needed to read `?kick`, `?ban`, etc. —
   without this the moderation commands silently do nothing) → Save.
3. **OAuth2 → URL Generator** → scope `bot` → permissions: Send Messages,
   Embed Links, Use Slash Commands, **Kick Members, Ban Members, Manage
   Messages, Moderate Members** (the last four are what let the moderation
   commands actually work) → open the generated URL → invite it to your
   server.
4. Turn on Developer Mode in Discord (User Settings → Advanced), then
   right-click your own name → **Copy User ID** → paste into `.env` as
   `DISCORD_OWNER_ID`. This is the only account that can use owner-only
   buttons on either panel.
5. Right-click the channel you want the **Hosting Panel** in → Copy
   Channel ID → paste as `DISCORD_PANEL_CHANNEL_ID`. Do the same for a
   second channel for the **Admin Panel** → `DISCORD_ADMIN_CHANNEL_ID`
   (or leave it blank to put both panels in the same channel).
6. Optional: another channel ID as `DISCORD_LOG_CHANNEL_ID` for
   join/leave/ban messages.
7. For AI Site Edit, add an `ANTHROPIC_API_KEY` from
   https://console.anthropic.com.
8. `npm install` → restart the server.

Both panels post themselves automatically on startup, then **edit that
same message** every time something changes (a bot deploys, someone bans
an account, etc.) rather than spamming new messages. If a panel doesn't
show up, check the server console — it now logs exactly why (wrong
channel ID, bot not in that server, missing permissions) instead of
failing silently.

### Corex Hosting Panel (`DISCORD_PANEL_CHANNEL_ID`)
- **My Bots** → pick a bot from the dropdown → Start / Stop / Restart /
  Logs / Delete buttons appear for it. Start/Stop/Restart/Delete are
  owner-only; anyone can check Logs.
- **Deploy** explains why it can't take a file directly (Discord buttons
  and modals can't carry attachments — only slash commands can) and
  points to `/deploy`, the one command that had to stay.
- **Refresh** and **Open Website** round it out.

### Corex Admin Panel (`DISCORD_ADMIN_CHANNEL_ID`)
- **Support** / **Bug Report** — open to everyone, same as the old
  `/panel` support embed.
- **Site Content** — open to everyone, shows the current live page text.
- **Accounts** — owner only, lists every website account with its IP,
  plan, and ban status.
- **AI Site Edit** — owner only, opens a form to describe the change; the
  AI proposes new text for a small whitelist of fields only, shown as a
  before/after with Apply/Cancel. Nothing goes live until Apply. It has
  no access to any other file or code on the server.
- **Ban / Unban / Grant / Revoke Premium** — owner only, each opens a
  quick one-field form for the username. Ban cascades to the account's
  IP too, same as the web admin panel's Ban button.

Every response on both panels is private (ephemeral) — only the person
who clicked sees it, even though the panels themselves are visible to
everyone in the channel.

**The only slash command left is `/deploy`** (`file: name: runtime:
[env:]`, owner only) — it has to stay a real command because file
attachments only work through slash command options in Discord's API,
never through buttons or modals. Discord's own upload limit (~24MB
non-boosted) applies — bigger bots still need the website.

Member joins, leaves, and bans are logged automatically (to the log
channel if you set one, and always to the admin dashboard).

### Moderation commands

These are old-style prefix commands (not slash commands, not panel
buttons) — type them straight into any channel: `?kick @user reason`.
Prefix defaults to `?`, changeable via `MOD_PREFIX` in `.env`.

- `?kick @user [reason]` — requires **Kick Members**
- `?ban @user [reason]` — requires **Ban Members**
- `?unban <user ID> [reason]` — requires **Ban Members** (bans don't keep
  a mentionable user in the server, so this takes a raw ID — right-click
  a user in the ban list, or check `?modlogs` for the ID)
- `?purge <1-100>` — requires **Manage Messages**, bulk-deletes that many
  messages in the channel (Discord itself won't bulk-delete anything
  older than 14 days — that's a Discord limit, not this bot's)
- `?timeout @user <10m|2h|1d> [reason]` / `?untimeout @user` — requires
  **Moderate Members**
- `?warn @user [reason]` — requires **Moderate Members**, DMs the user
  and logs it
- `?modlogs [@user]` — shows recent moderation actions, optionally
  filtered to one person

Every action is checked against real Discord permissions (not just the
bot's owner) — anyone with Kick Members, Ban Members, etc. on your server
can use the matching commands, same as any other mod bot. Every action
also gets logged (to the log channel if set, and to
`data/mod-log.json`), and confirms with an embed matching the rest of the
bot's style. If a command silently does nothing, the two most common
causes are: Message Content Intent isn't turned on (step 2 above), or the
bot's own role is below the target's role in Server Settings → Roles —
Discord requires a bot's role to be higher than anyone it acts on.

### "Invalid token" checklist

This almost always means one of these, in order of likelihood:
1. **Railway doesn't have it.** Your local `.env` file never reaches
   Railway — you have to add `DISCORD_BOT_TOKEN` (and every other env var)
   in Railway's dashboard under your service → **Variables**, separately
   from your local file.
2. **Wrong value copied.** The Bot tab's Token is different from the
   OAuth2 tab's Client Secret and Client ID — easy to grab the wrong one.
3. **Token was reset since you copied it.** Clicking "Reset Token" in the
   Discord Developer Portal instantly kills the old one. It can only be
   viewed once, right when generated — if you navigate away, you have to
   reset it again to see a fresh copy.
4. A stray space or line break from copy-pasting (the code now trims this
   automatically, but check your source).

The server console now logs a masked preview of whatever token it's
actually using when login fails, plus this same checklist — that's the
fastest way to see if the value it received is even close to right.

### On the Railway slowness

Some of this is architectural, not a bug: every hosted bot runs as its own
full process alongside the website's server and this Discord bot, all in
one container. Railway's free/starter tier gives that container very
little CPU and RAM to share between all of them — a couple of busy
Discord.js bots can genuinely eat everything else's headroom. Two things
that help:
- Hosted bots now run at a lower CPU priority than the main server (via
  `nice` on Linux), so they shouldn't be able to starve the website and
  admin bot anymore — already included in this update.
- Beyond that, the real fix is more resources: check Railway's Metrics tab
  for your service to see if you're CPU or memory capped, and upgrade the
  plan if so. Running "a platform that hosts other Discord bots" is
  inherently heavier than a typical small web app — it's genuinely running
  N+1 programs at once, not one.

### Alternatives to Railway

Worth knowing up front: this app needs somewhere that (a) stays running
24/7 without sleeping, (b) has a real persistent disk for uploaded bots,
and (c) lets you `npm install` and spawn child processes. That rules out
most "serverless" platforms outright — this isn't a fit for anything built
around short-lived function calls. Checked current terms on the popular
free options as of this update:

- **Render (free tier)** — spins down after 15 minutes of no traffic
  (30–60s cold start on the next request) and, more importantly, **the
  free tier has no persistent disk at all** — anything written to disk
  gets wiped on every restart. That breaks bot storage and account data
  outright. Their paid Starter tier ($7/mo) fixes both.
- **Fly.io** — no longer has a real free tier as of 2026; new accounts get
  a trial capped at 2 VM-hours or 7 days, then it's pay-as-you-go
  (roughly $2–5/mo for a small always-on instance with a volume).
- **Oracle Cloud "Always Free"** — genuinely free forever, and the only
  option here with real always-on compute at no cost: up to 4 ARM
  vCPUs/24GB RAM (recently trimmed to 2/12 in some accounts) plus 200GB
  storage. The catch is it's a raw Linux VM, not a "push and deploy"
  platform — more setup work (SSH, systemd/pm2, your own reverse proxy),
  and popular regions sometimes run out of free capacity when you try to
  provision.
- **A cheap VPS (Hetzner, Contabo, etc.)** — not free, but Hetzner's
  smallest box runs about €4.60/mo and is a real dedicated slice of a
  server with no shared-tenant CPU throttling. Combined with something
  like Coolify (free, self-hosted) you get a Heroku-style `git push`
  deploy flow on your own hardware. Honestly the best price-to-reliability
  ratio if you're open to spending a few dollars a month.
- **Staying on Railway** — is not unreasonable; it's architecturally a
  good fit (persistent volumes, always-on). If it's slow, it's very
  likely the plan tier rather than the platform — check Metrics before
  assuming you need to move.

If truly $0/month matters most and you're comfortable with a bit more
setup, Oracle Cloud is the one honest "free forever" answer here. If a
few dollars a month is fine, Hetzner + Coolify or just upgrading Railway's
plan will save you the most time.





## Why deploys are much faster now

Two changes, one of them a real architectural fix rather than just flag
tweaking:

- **Shared dependency cache** — the first time any bot installs a given
  `package.json` + lockfile (or `requirements.txt`), the resulting
  `node_modules` (or Python packages) gets saved once to
  `data/dep-cache/`. Every future bot with the *same* dependencies —
  which is most Discord.js bots, since they mostly share discord.js,
  dotenv, etc. — skips `npm install`/`pip install` entirely and gets its
  dependencies hardlinked in instead. A hardlink is just a second
  directory entry pointing at the same data already on disk, so this
  takes milliseconds regardless of how large `node_modules` is, instead
  of however long a real install takes. First deploy of a new dependency
  set is normal speed; every matching deploy after that is close to
  instant.
- **Leaner installs when a real install still happens** — `npm ci`
  instead of `npm install` when a lockfile exists (skips dependency
  resolution), `--no-audit --no-fund --prefer-offline`, and `pip install
  --prefer-binary` to avoid building packages from source when a
  precompiled wheel exists.

Realistically, the very first time you deploy a brand new kind of bot it
still takes as long as a normal install always does — that part is
bounded by downloading packages from npm/PyPI, which no amount of local
caching can skip. The speedup is specifically on the second, third,
fourth deploy of anything with matching dependencies.
