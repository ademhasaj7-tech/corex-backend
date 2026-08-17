// accountsTracking.js
// Tracks which IP created which account, so signup can enforce "one account
// per IP" and the admin panel can ban an IP outright.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'ip-log.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ registrations: [], bannedIps: [] }, null, 2));

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return { registrations: [], bannedIps: [] }; }
}
function save(d) { fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }

function isIpBanned(ip) { return load().bannedIps.includes(ip); }

function accountsForIp(ip) {
  return load().registrations.filter(r => r.ip === ip);
}

function registerAccount(username, ip, email) {
  const d = load();
  d.registrations.push({ username, ip, email: email || null, createdAt: new Date().toISOString() });
  save(d);
}

function banIp(ip) {
  const d = load();
  if (!d.bannedIps.includes(ip)) d.bannedIps.push(ip);
  save(d);
}
function unbanIp(ip) {
  const d = load();
  d.bannedIps = d.bannedIps.filter(x => x !== ip);
  save(d);
}

function allRegistrations() { return load().registrations; }
function bannedIps() { return load().bannedIps; }
function ipForUsername(username) {
  const match = load().registrations.find(r => r.username.toLowerCase() === username.toLowerCase());
  return match ? match.ip : null;
}

// --- username bans (server-side source of truth, usable from Discord too) ---
function isUsernameBanned(username) {
  const d = load();
  return (d.bannedUsers || []).includes(username.toLowerCase());
}
function banUsername(username) {
  const d = load();
  d.bannedUsers = d.bannedUsers || [];
  if (!d.bannedUsers.includes(username.toLowerCase())) d.bannedUsers.push(username.toLowerCase());
  save(d);
  const ip = ipForUsername(username);
  if (ip) banIp(ip); // cascade, same as the web admin panel does
}
function unbanUsername(username) {
  const d = load();
  d.bannedUsers = (d.bannedUsers || []).filter(u => u !== username.toLowerCase());
  save(d);
}
function listAccounts() {
  return allRegistrations().map(r => ({
    username: r.username,
    ip: r.ip,
    email: r.email,
    createdAt: r.createdAt,
    banned: isUsernameBanned(r.username),
  }));
}

module.exports = {
  isIpBanned, accountsForIp, registerAccount,
  banIp, unbanIp, allRegistrations, bannedIps, ipForUsername,
  isUsernameBanned, banUsername, unbanUsername, listAccounts,
};
