// server.js
// REST API for corex hosting. Run this on a VPS/server you control —
// it needs to stay running (see README for pm2/systemd setup) so that the
// bots it manages stay running too.

require('dotenv').config();

// Never let one bad request take the whole server down — log it and keep
// serving everything else instead (a hard crash here is what turns into
// "could not reach the backend" for every other request afterward).
process.on('uncaughtException', (err) => {
  console.error('[corex] uncaught exception (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[corex] unhandled rejection (server kept running):', err);
});

const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bm = require('./botManager');
const premium = require('./premium');
const sales = require('./sales');
const accountsTracking = require('./accountsTracking');
const email = require('./email');
const discordBot = require('./discordBot');

// --- Stripe (optional — stays inactive until you add real keys to .env) --
// This never stores card numbers itself; Stripe's own hosted checkout page
// handles all of that, which is what keeps this legal and safe to run.
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); }
  catch (e) { console.warn('[corex] "stripe" package not installed yet — run `npm install` after adding your keys.'); }
}

const app = express();
app.set('trust proxy', true); // needed for req.ip to be the real client IP behind Railway/any reverse proxy
app.use(cors());

// Stripe's webhook needs the RAW request body to verify the signature, so
// this has to be registered before the global express.json() below.
app.post('/api/premium/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(501).send('Webhook not configured yet — add STRIPE_WEBHOOK_SECRET to .env.');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[corex] webhook signature check failed:', e.message);
    return res.status(400).send('Webhook signature verification failed.');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const username = session.metadata && session.metadata.username;
    if (username) {
      premium.setPremium(username, true);
      sales.record({
        username,
        email: session.customer_details ? session.customer_details.email : null,
        amountTotal: session.amount_total,
        currency: session.currency,
        sessionId: session.id,
      });
      console.log(`[corex] payment received — ${username} is now premium.`);
    }
  }
  res.json({ received: true });
});

app.use(express.json());

// Serve the landing page (public/index.html and any assets next to it)
app.use(express.static(path.join(__dirname, 'public')));

const TMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 20 * 1024 * 1024 * 1024 } }); // 20GB per bot

// --- very basic auth --------------------------------------------------
// Replace with real per-user auth before going live. For now, every
// /api request must carry the shared key below so the API isn't wide open.
// (The frontend page itself is served freely, above — this only guards /api.)
const API_KEY = process.env.COREX_API_KEY || 'change-me-before-deploying';
const ADMIN_USER = process.env.COREX_ADMIN_USER || 'corex';
const ADMIN_PASS = process.env.COREX_ADMIN_PASS || '3548';

// Registered BEFORE the key gate below on purpose — this is a chicken-and-egg
// exception: it's the one route that hands the API key out, so it can't
// itself require the key. It's protected by the admin username/password
// instead. Logging in as admin in the dashboard calls this automatically so
// you never have to copy the key out of the console by hand.
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ apiKey: API_KEY });
  }
  res.status(401).json({ error: 'Invalid admin credentials' });
});

// --- Discord login (OAuth2) ----------------------------------------------
// Registered before the API key gate on purpose — a browser navigates to
// these directly (they're links/redirects, not authenticated fetch calls).
// Requires a free Discord application: see README for setup.
const pendingDiscordLogins = new Map(); // one-time token -> { username, discordId, expiresAt }

function discordRedirectUri(req) {
  return process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/discord/callback`;
}

app.get('/api/auth/discord', (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID) {
    return res.status(501).send('Discord login isn\'t set up yet — add DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET to .env (see README).');
  }
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: discordRedirectUri(req),
    response_type: 'code',
    scope: 'identify email',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code || !process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return res.status(400).send('Discord login isn\'t configured or the request was invalid.');
  }
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: discordRedirectUri(req),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token from Discord');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();

    // One-time token instead of putting the username straight in the URL —
    // stops anyone from just typing ?discord_username=whatever themselves.
    const loginToken = crypto.randomBytes(16).toString('hex');
    pendingDiscordLogins.set(loginToken, {
      username: discordUser.username,
      discordId: discordUser.id,
      email: discordUser.email || null,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const origin = `${req.protocol}://${req.get('host')}`;
    res.redirect(`${origin}/?discord_token=${loginToken}`);
  } catch (e) {
    console.error('[corex] Discord login failed:', e);
    res.status(500).send('Discord login failed. Check the server console for details.');
  }
});

app.get('/api/auth/discord/session/:token', (req, res) => {
  const entry = pendingDiscordLogins.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Invalid or expired login token' });
  }
  pendingDiscordLogins.delete(req.params.token); // single-use
  res.json({ username: entry.username, discordId: entry.discordId, email: entry.email });
});

// --- Google login (OAuth2) ------------------------------------------------
const pendingGoogleLogins = new Map();

function googleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
}

app.get('/api/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(501).send('Google login isn\'t set up yet — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env (see README).');
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).send('Google login isn\'t configured or the request was invalid.');
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: googleRedirectUri(req),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token from Google');

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();

    // Google doesn't have "usernames" — derive one from the email, and let
    // the frontend de-duplicate against existing accounts the normal way.
    const baseUsername = (googleUser.email || 'user').split('@')[0].replace(/[^a-zA-Z0-9_]/g, '');

    const loginToken = crypto.randomBytes(16).toString('hex');
    pendingGoogleLogins.set(loginToken, {
      username: baseUsername,
      googleId: googleUser.id,
      email: googleUser.email || null,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const origin = `${req.protocol}://${req.get('host')}`;
    res.redirect(`${origin}/?google_token=${loginToken}`);
  } catch (e) {
    console.error('[corex] Google login failed:', e);
    res.status(500).send('Google login failed. Check the server console for details.');
  }
});

app.get('/api/auth/google/session/:token', (req, res) => {
  const entry = pendingGoogleLogins.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Invalid or expired login token' });
  }
  pendingGoogleLogins.delete(req.params.token);
  res.json({ username: entry.username, googleId: entry.googleId, email: entry.email });
});

// --- GitHub login (OAuth2) -------------------------------------------------
const pendingGithubLogins = new Map();

function githubRedirectUri(req) {
  return process.env.GITHUB_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/github/callback`;
}

app.get('/api/auth/github', (req, res) => {
  if (!process.env.GITHUB_CLIENT_ID) {
    return res.status(501).send('GitHub login isn\'t set up yet — add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env (see README).');
  }
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: githubRedirectUri(req),
    scope: 'read:user user:email',
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/api/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code || !process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return res.status(400).send('GitHub login isn\'t configured or the request was invalid.');
  }
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: githubRedirectUri(req),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token from GitHub');

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'corex-hosting' },
    });
    const githubUser = await userRes.json();

    // GitHub's /user endpoint often omits email if it's set private —
    // /user/emails needs the scope we requested above to fall back to it.
    let email = githubUser.email || null;
    if (!email) {
      try {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'corex-hosting' },
        });
        const emails = await emailsRes.json();
        const primary = Array.isArray(emails) ? emails.find(e => e.primary) || emails[0] : null;
        email = primary ? primary.email : null;
      } catch (e) { /* not critical — proceed without an email */ }
    }

    const loginToken = crypto.randomBytes(16).toString('hex');
    pendingGithubLogins.set(loginToken, {
      username: githubUser.login,
      githubId: githubUser.id,
      email,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const origin = `${req.protocol}://${req.get('host')}`;
    res.redirect(`${origin}/?github_token=${loginToken}`);
  } catch (e) {
    console.error('[corex] GitHub login failed:', e);
    res.status(500).send('GitHub login failed. Check the server console for details.');
  }
});

app.get('/api/auth/github/session/:token', (req, res) => {
  const entry = pendingGithubLogins.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Invalid or expired login token' });
  }
  pendingGithubLogins.delete(req.params.token);
  res.json({ username: entry.username, githubId: entry.githubId, email: entry.email });
});

// Public — the frontend fetches this on load to render any AI-edited copy.
// No API key needed since this is just page content, same as the HTML itself.
app.get('/api/site-content', (req, res) => {
  res.json(discordBot.loadContent());
});

// Public — the login flow checks this so a ban applied from Discord or the
// web admin panel actually blocks login, not just the local browser copy.
app.get('/api/accounts/status/:username', (req, res) => {
  res.json({
    banned: accountsTracking.isUsernameBanned(req.params.username),
    premium: premium.isPremium(req.params.username),
  });
});

app.use('/api', (req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }
  next();
});

function writeFolderFiles(botDir, folderFiles) {
  let skipped = 0;
  for (const f of folderFiles) {
    let relPath = f.originalname.replace(/\\/g, '/');
    // webkitRelativePath prefixes with the selected folder's own name
    // (e.g. "mybot/index.js") — drop that first segment so files land at
    // the bot's root, where the runtime actually looks for them.
    const segments = relPath.split('/').filter(Boolean);
    if (segments.length > 1) segments.shift();
    relPath = segments.join('/');

    const normalized = path.normalize(relPath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) { skipped++; continue; }

    const dest = path.join(botDir, normalized);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(f.path, dest);
    } catch (fileErr) {
      // A single locked/permission-denied file (common on OneDrive-synced
      // folders on Windows) shouldn't take down the whole upload.
      console.error('[corex] skipped one file in upload:', relPath, fileErr.message);
      skipped++;
    }
  }
  return skipped;
}

// --- create an empty bot record (used by both the zip flow and the
// batched folder flow below) --------------------------------------------
app.post('/api/bots/init', (req, res) => {
  const { name, runtime } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = crypto.randomBytes(6).toString('hex');
  const botDir = path.join(bm.BOTS_DIR, id);
  fs.mkdirSync(botDir, { recursive: true });

  const bots = bm.loadDb();
  const bot = {
    id, name,
    runtime: runtime === 'python' ? 'python' : 'node',
    status: 'offline',
    createdAt: new Date().toISOString(),
  };
  bots.push(bot);
  bm.saveDb(bots);
  res.json(bot);
});

// --- add a batch of files to an already-created bot (folder uploads) ----
// Sending one huge request with thousands of files is fragile — browsers,
// antivirus, and proxies can all choke on it and fail with no server-side
// trace at all. Small batches are far more reliable.
const uploadBatch = upload.array('files', 500);
app.post('/api/bots/:id/files', uploadBatch, (req, res) => {
  const bot = bm.loadDb().find((b) => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const botDir = path.join(bm.BOTS_DIR, bot.id);
  const files = req.files || [];
  const skipped = writeFolderFiles(botDir, files);
  res.json({ ok: true, received: files.length, skipped });
});

// --- list / create ------------------------------------------------------
app.get('/api/bots', (req, res) => {
  const bots = bm.loadDb().map((b) => ({ ...b, status: bm.getStatus(b.id) }));
  res.json(bots);
});

const uploadBot = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 20000 }]);

app.post('/api/bots', uploadBot, async (req, res) => {
  const { name, runtime } = req.body;
  const zipFile = req.files?.file?.[0];
  const folderFiles = req.files?.files || [];

  if (!name || (!zipFile && folderFiles.length === 0)) {
    return res.status(400).json({ error: 'name and either a zip file or a folder are required' });
  }

  const id = crypto.randomBytes(6).toString('hex');
  const botDir = path.join(bm.BOTS_DIR, id);
  fs.mkdirSync(botDir, { recursive: true });

  if (zipFile) {
    try {
      const stat = fs.statSync(zipFile.path);
      if (stat.size === 0) throw new Error('The uploaded zip is empty (0 bytes) — the upload may not have finished.');

      // A real zip starts with the bytes 'PK'. Catch obviously-wrong files
      // early with a clear message instead of a confusing extractor error.
      const fd = fs.openSync(zipFile.path, 'r');
      const header = Buffer.alloc(2);
      fs.readSync(fd, header, 0, 2, 0);
      fs.closeSync(fd);
      if (header.toString('ascii') !== 'PK') {
        throw new Error('That file doesn\'t look like a valid .zip (missing zip file header). Re-zip your bot folder and try again.');
      }

      // Open via the zip's central directory (the file's real index) rather
      // than streaming sequentially from byte 0 — sequential streaming loses
      // sync on some large/data-descriptor zips, which is what threw
      // "unexpected end of file" before. This mode reads known offsets per
      // entry instead, and still never loads the whole file into memory.
      const directory = await unzipper.Open.file(zipFile.path);
      await directory.extract({ path: botDir, concurrency: 4 });
    } catch (e) {
      console.error('Zip extract failed:', e);
      fs.rmSync(botDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'Could not extract zip file: ' + e.message });
    } finally {
      fs.unlink(zipFile.path, () => {});
    }
  } else {
    const skipped = writeFolderFiles(botDir, folderFiles);
    if (skipped) console.warn(`[corex] folder upload finished with ${skipped} file(s) skipped`);
  }

  const bots = bm.loadDb();
  const bot = {
    id, name,
    runtime: runtime === 'python' ? 'python' : 'node',
    status: 'offline',
    createdAt: new Date().toISOString(),
  };
  bots.push(bot);
  bm.saveDb(bots);

  res.json(bot);
});

app.get('/api/bots/:id', (req, res) => {
  const bot = bm.loadDb().find((b) => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json({ ...bot, status: bm.getStatus(bot.id) });
});

app.delete('/api/bots/:id', (req, res) => {
  bm.stopBot(req.params.id);
  const bots = bm.loadDb().filter((b) => b.id !== req.params.id);
  bm.saveDb(bots);
  fs.rm(path.join(bm.BOTS_DIR, req.params.id), { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

// --- lifecycle -----------------------------------------------------------
app.post('/api/bots/:id/start', async (req, res) => {
  try { await bm.startBot(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/bots/:id/stop', (req, res) => {
  bm.stopBot(req.params.id);
  res.json({ ok: true });
});

app.post('/api/bots/:id/restart', async (req, res) => {
  try { await bm.restartBot(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- env vars (e.g. DISCORD_TOKEN) ---------------------------------------
app.post('/api/bots/:id/env', (req, res) => {
  const envPath = path.join(bm.BOTS_DIR, req.params.id, '.env.json');
  if (!fs.existsSync(path.join(bm.BOTS_DIR, req.params.id))) {
    return res.status(404).json({ error: 'Bot not found' });
  }
  fs.writeFileSync(envPath, JSON.stringify(req.body || {}, null, 2));
  res.json({ ok: true });
});

// --- logs ------------------------------------------------------------
app.get('/api/bots/:id/logs', (req, res) => {
  res.json(bm.getLogs(req.params.id));
});

// live log stream via Server-Sent Events
app.get('/api/bots/:id/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
  const unsubscribe = bm.subscribeLogs(req.params.id, send);
  req.on('close', unsubscribe);
});

// Catch multer/upload errors and any other thrown errors cleanly instead of
// crashing with a raw stack trace.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is too large. Current limit is 20GB per bot — edit the fileSize limit in server.js to raise it further.' });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'Too many files in that folder (limit is 5000). Try zipping it instead.' });
  }
  if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Unexpected file field: ' + err.field });
  }
  if (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
  next();
});

// --- premium upgrade (£1 one-time, via Stripe Checkout) ------------------
app.post('/api/premium/checkout', async (req, res) => {
  if (!stripe || !process.env.STRIPE_PRICE_ID) {
    return res.status(501).json({ error: "Payments aren't set up yet — add STRIPE_SECRET_KEY and STRIPE_PRICE_ID to .env to turn this on." });
  }
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username is required' });

  try {
    const origin = req.headers.origin || (req.protocol + '://' + req.get('host'));
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: origin + '/?upgraded=1',
      cancel_url: origin + '/?upgraded=0',
      metadata: { username },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/premium/status/:username', (req, res) => {
  res.json({ premium: premium.isPremium(req.params.username) });
});

// Admin-panel manual override (Grant/Revoke premium buttons) — keeps the
// real server-side record in sync with the admin's decision, same store
// the Stripe webhook writes to.
app.post('/api/premium/set', (req, res) => {
  const { username, value } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username is required' });
  premium.setPremium(username, !!value);
  res.json({ ok: true });
});

// Admin-facing: recent sales (real payout details live in your Stripe
// dashboard — this is just a convenient local log of what's come in).
app.get('/api/premium/sales', (req, res) => {
  res.json(sales.list());
});

// --- account registration & one-account-per-IP ---------------------------
// Called from the frontend on every new signup (email/password or first-time
// Discord login). This is the one place that actually knows the visitor's
// real IP, so it's the right place to both enforce the one-account rule and
// fire off the Discord welcome email.
app.post('/api/accounts/register', (req, res) => {
  const { username, email: userEmail } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username is required' });
  const ip = req.ip;

  if (accountsTracking.isIpBanned(ip)) {
    return res.status(403).json({ error: 'This IP address is banned from creating accounts.' });
  }

  const existing = accountsTracking.accountsForIp(ip);
  const alreadyThisUser = existing.some(r => r.username.toLowerCase() === username.toLowerCase());
  if (existing.length > 0 && !alreadyThisUser) {
    return res.status(409).json({ error: 'Only one account is allowed per IP address, and this IP already has one.' });
  }

  if (!alreadyThisUser) {
    accountsTracking.registerAccount(username, ip, userEmail);
    if (userEmail) email.sendWelcomeEmail(userEmail, username); // fire-and-forget
  }
  res.json({ ok: true });
});

// Admin-facing: see who signed up from where, and ban an IP outright.
app.get('/api/accounts/ip-log', (req, res) => {
  res.json({ registrations: accountsTracking.allRegistrations(), bannedIps: accountsTracking.bannedIps() });
});
app.post('/api/accounts/ban-ip', (req, res) => {
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip is required' });
  accountsTracking.banIp(ip);
  res.json({ ok: true });
});
app.post('/api/accounts/unban-ip', (req, res) => {
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip is required' });
  accountsTracking.unbanIp(ip);
  res.json({ ok: true });
});
app.get('/api/accounts/list', (req, res) => {
  res.json(accountsTracking.listAccounts().map(a => ({ ...a, premium: premium.isPremium(a.username) })));
});
app.post('/api/accounts/ban-username', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username is required' });
  accountsTracking.banUsername(username);
  res.json({ ok: true });
});
app.post('/api/accounts/unban-username', (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username is required' });
  accountsTracking.unbanUsername(username);
  res.json({ ok: true });
});

// Admin-facing: recent Discord joins/leaves/bans, for the dashboard.
app.get('/api/discord/activity', (req, res) => {
  res.json(discordBot.loadActivity());
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`corex hosting backend listening on :${PORT}`);
  console.log(`API key required on every request: x-api-key: ${API_KEY}`);

  // A single, clear report of what's actually configured — the fastest way
  // to spot "oh, I never set that" instead of guessing why something's not
  // working after deploying somewhere new.
  const check = (label, ok) => console.log(`  [${ok ? 'x' : ' '}] ${label}`);
  console.log('\n--- corex config status ---');
  check('COREX_API_KEY set to something other than the default', API_KEY !== 'change-me-before-deploying');
  check('DISCORD_BOT_TOKEN set', !!process.env.DISCORD_BOT_TOKEN);
  check('DISCORD_OWNER_ID set', !!process.env.DISCORD_OWNER_ID);
  check('STRIPE_SECRET_KEY set (premium payments)', !!process.env.STRIPE_SECRET_KEY);
  check('ANTHROPIC_API_KEY set (AI site-edit)', !!process.env.ANTHROPIC_API_KEY);
  check('SMTP_HOST set (welcome emails)', !!process.env.SMTP_HOST);
  check('GOOGLE_CLIENT_ID set', !!process.env.GOOGLE_CLIENT_ID);
  check('GITHUB_CLIENT_ID set', !!process.env.GITHUB_CLIENT_ID);
  console.log('Anything unchecked above is simply turned off, not broken — fill in .env (or your host\'s env vars) to enable it.');
  console.log('---------------------------\n');

  // Bring back any bots that were online before a server restart.
  bm.loadDb().forEach((b) => {
    if (b.status === 'online' || b.status === 'restarting') {
      bm.startBot(b.id).catch(() => {});
    }
  });

  discordBot.startDiscordBot();
});
