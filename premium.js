// premium.js
// Tracks who has actually paid, server-side — this is the real source of
// truth (a browser's localStorage isn't, since a Stripe webhook fires with
// no browser open).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'premium.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '{}');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return {}; }
}
function save(d) { fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }

function isPremium(username) {
  if (!username) return false;
  return !!load()[username.toLowerCase()];
}
function setPremium(username, value) {
  const d = load();
  d[username.toLowerCase()] = value;
  save(d);
}
function listPremium() { return load(); }

module.exports = { isPremium, setPremium, listPremium };
