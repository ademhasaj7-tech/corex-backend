// botManager.js
// Owns the lifecycle of every hosted bot process: starting it, watching it,
// restarting it if it dies unexpectedly, and keeping a rolling log buffer.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const BOTS_DIR = path.join(__dirname, 'bots');
const DB_FILE = path.join(DATA_DIR, 'bots.json');
const DEP_CACHE_DIR = path.join(DATA_DIR, 'dep-cache'); // reused across every bot with matching deps
const MAX_LOG_LINES = 500;
const RESTART_BACKOFF_MS = 1200;      // wait before respawning a crashed bot
const CRASH_LOOP_THRESHOLD = 5;       // if it crashes this many times quickly...
const CRASH_LOOP_WINDOW_MS = 60000;   // ...within this window, stop auto-restarting

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(DEP_CACHE_DIR)) fs.mkdirSync(DEP_CACHE_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

function loadDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDb(bots) {
  fs.writeFileSync(DB_FILE, JSON.stringify(bots, null, 2));
}

// In-memory runtime state — process handles and logs never touch disk directly.
// (logs are kept in memory only; swap for a real log store if you need history
// to survive a server restart)
const runtime = new Map(); // id -> { proc, logs: [], listeners: Set, crashes: [], status }

function emitLog(id, line) {
  const rt = runtime.get(id);
  if (!rt) return;
  const entry = { t: Date.now(), line };
  rt.logs.push(entry);
  if (rt.logs.length > MAX_LOG_LINES) rt.logs.shift();
  rt.listeners.forEach((send) => send(entry));
}

function setStatus(id, status) {
  const bots = loadDb();
  const bot = bots.find((b) => b.id === id);
  if (bot) {
    bot.status = status;
    saveDb(bots);
  }
  const rt = runtime.get(id);
  if (rt) rt.status = status;
}

function getEntryCommand(botDir, runtimeType) {
  if (runtimeType === 'python') {
    const main = fs.existsSync(path.join(botDir, 'main.py')) ? 'main.py' : 'bot.py';
    return { cmd: 'python3', args: [main] };
  }
  // default: node
  let entry = 'index.js';
  const pkgPath = path.join(botDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main) entry = pkg.main;
    } catch (_) {}
  }
  return { cmd: 'node', args: [entry] };
}

// Instant, zero-copy-cost directory clone via hardlinks — every file just
// gets a second directory entry pointing at the same data on disk, so
// "copying" even a huge node_modules folder takes milliseconds instead of
// however long a real byte-for-byte copy would take.
function hardlinkTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      hardlinkTree(s, d);
    } else if (entry.isSymbolicLink()) {
      try { fs.symlinkSync(fs.readlinkSync(s), d); } catch (_) {}
    } else {
      try { fs.linkSync(s, d); }
      catch (_) { try { fs.copyFileSync(s, d); } catch (__) {} } // cross-device fallback
    }
  }
}

function hashFile(...contents) {
  return crypto.createHash('sha1').update(contents.join('\n')).digest('hex');
}

function installDeps(id, botDir, runtimeType) {
  return new Promise((resolve) => {
    if (runtimeType === 'python' && fs.existsSync(path.join(botDir, 'requirements.txt'))) {
      const reqContent = fs.readFileSync(path.join(botDir, 'requirements.txt'), 'utf8');
      const cacheDir = path.join(DEP_CACHE_DIR, 'py-' + hashFile(reqContent));

      if (fs.existsSync(cacheDir)) {
        emitLog(id, '[corex] reusing cached Python packages (instant — matches a previous deploy)');
        hardlinkTree(cacheDir, path.join(botDir, '.corex_site_packages'));
        return resolve({ pythonPath: path.join(botDir, '.corex_site_packages') });
      }

      const target = path.join(botDir, '.corex_site_packages');
      fs.mkdirSync(target, { recursive: true });
      const proc = spawn('python3', ['-m', 'pip', 'install', '--break-system-packages', '-r', 'requirements.txt', '--target', target, '--prefer-binary', '--no-input'], { cwd: botDir });
      proc.stdout.on('data', (d) => emitLog(id, d.toString()));
      proc.stderr.on('data', (d) => emitLog(id, d.toString()));
      proc.on('close', () => {
        try { hardlinkTree(target, cacheDir); } catch (e) { /* caching is best-effort */ }
        resolve({ pythonPath: target });
      });
      proc.on('error', () => resolve({ pythonPath: target }));
      return;
    }

    if (runtimeType !== 'python' && fs.existsSync(path.join(botDir, 'package.json'))) {
      const pkgContent = fs.readFileSync(path.join(botDir, 'package.json'), 'utf8');
      const lockPath = path.join(botDir, 'package-lock.json');
      const hasLock = fs.existsSync(lockPath);
      const lockContent = hasLock ? fs.readFileSync(lockPath, 'utf8') : '';
      const cacheDir = path.join(DEP_CACHE_DIR, 'npm-' + hashFile(pkgContent, lockContent));

      // The actual speed win: if this exact package.json (+ lockfile) has
      // been installed before by ANY bot, skip npm entirely and hardlink
      // the already-built node_modules straight in. This is what makes
      // deploying "another discord.js bot" go from ~15-30s to ~1s.
      if (fs.existsSync(cacheDir)) {
        emitLog(id, '[corex] reusing cached dependencies (instant — matches a previous deploy)');
        hardlinkTree(cacheDir, path.join(botDir, 'node_modules'));
        return resolve({});
      }

      const cmd = 'npm';
      const args = hasLock
        ? ['ci', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline']
        : ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'];
      const proc = spawn(cmd, args, { cwd: botDir });
      proc.stdout.on('data', (d) => emitLog(id, d.toString()));
      proc.stderr.on('data', (d) => emitLog(id, d.toString()));
      proc.on('close', () => {
        const nm = path.join(botDir, 'node_modules');
        if (fs.existsSync(nm)) {
          try { hardlinkTree(nm, cacheDir); } catch (e) { /* caching is best-effort — a failure here shouldn't break the deploy */ }
        }
        resolve({});
      });
      proc.on('error', () => resolve({}));
      return;
    }

    resolve({});
  });
}

async function startBot(id) {
  const bots = loadDb();
  const bot = bots.find((b) => b.id === id);
  if (!bot) throw new Error('Bot not found');

  const botDir = path.join(BOTS_DIR, id);
  if (!fs.existsSync(botDir)) throw new Error('Bot files not found on disk');

  if (!runtime.has(id)) {
    runtime.set(id, { proc: null, logs: [], listeners: new Set(), crashes: [], status: 'installing' });
  }
  const rt = runtime.get(id);
  if (rt.proc) return; // already running

  setStatus(id, 'installing');
  emitLog(id, '[corex] installing dependencies…');
  await installDeps(id, botDir, bot.runtime);

  spawnProcess(id, bot, botDir);
}

function spawnProcess(id, bot, botDir) {
  const { cmd, args } = getEntryCommand(botDir, bot.runtime);
  const envPath = path.join(botDir, '.env.json');
  let envVars = {};
  if (fs.existsSync(envPath)) {
    try { envVars = JSON.parse(fs.readFileSync(envPath, 'utf8')); } catch (_) {}
  }
  const sitePackages = path.join(botDir, '.corex_site_packages');
  if (bot.runtime === 'python' && fs.existsSync(sitePackages)) {
    envVars.PYTHONPATH = sitePackages + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '');
  }

  emitLog(id, `[corex] starting: ${cmd} ${args.join(' ')}`);
  // On Linux (Railway included), run hosted bots at a lower CPU priority
  // than the main server process via `nice`, so a busy/greedy bot can't
  // starve the website and admin bot of CPU. No-op elsewhere.
  const useNice = process.platform === 'linux';
  const proc = useNice
    ? spawn('nice', ['-n', '10', cmd, ...args], { cwd: botDir, env: { ...process.env, ...envVars } })
    : spawn(cmd, args, { cwd: botDir, env: { ...process.env, ...envVars } });

  const rt = runtime.get(id);
  rt.proc = proc;
  setStatus(id, 'online');

  proc.stdout.on('data', (d) => emitLog(id, d.toString()));
  proc.stderr.on('data', (d) => emitLog(id, d.toString()));

  proc.on('exit', (code) => {
    const rt = runtime.get(id);
    if (!rt) return;
    rt.proc = null;
    emitLog(id, `[corex] process exited (code ${code})`);

    // Manual stop -> don't restart.
    if (rt.status === 'stopping') {
      setStatus(id, 'offline');
      return;
    }

    // Crash-loop detection.
    const now = Date.now();
    rt.crashes = rt.crashes.filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
    rt.crashes.push(now);
    if (rt.crashes.length >= CRASH_LOOP_THRESHOLD) {
      emitLog(id, '[corex] crashing too often — pausing auto-restart. Fix the bot, then start it manually.');
      setStatus(id, 'crashed');
      return;
    }

    emitLog(id, `[corex] restarting in ${RESTART_BACKOFF_MS / 1000}s…`);
    setStatus(id, 'restarting');
    setTimeout(() => {
      const bots = loadDb();
      const bot = bots.find((b) => b.id === id);
      const stillRt = runtime.get(id);
      if (bot && stillRt && stillRt.status !== 'stopping') {
        spawnProcess(id, bot, path.join(BOTS_DIR, id));
      }
    }, RESTART_BACKOFF_MS);
  });
}

function stopBot(id) {
  const rt = runtime.get(id);
  if (!rt || !rt.proc) {
    setStatus(id, 'offline');
    return;
  }
  rt.status = 'stopping';
  rt.proc.kill('SIGTERM');
  setTimeout(() => { if (rt.proc) rt.proc.kill('SIGKILL'); }, 5000);
}

async function restartBot(id) {
  stopBot(id);
  await new Promise((r) => setTimeout(r, 800));
  await startBot(id);
}

function getLogs(id) {
  const rt = runtime.get(id);
  return rt ? rt.logs : [];
}

function subscribeLogs(id, send) {
  if (!runtime.has(id)) {
    runtime.set(id, { proc: null, logs: [], listeners: new Set(), crashes: [], status: 'offline' });
  }
  const rt = runtime.get(id);
  rt.listeners.add(send);
  return () => rt.listeners.delete(send);
}

function getStatus(id) {
  const rt = runtime.get(id);
  return rt ? rt.status : 'offline';
}

module.exports = {
  loadDb, saveDb,
  startBot, stopBot, restartBot,
  getLogs, subscribeLogs, getStatus,
  BOTS_DIR,
};
