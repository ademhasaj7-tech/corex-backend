// sales.js
// A simple running log of completed payments, for the admin dashboard's
// sales view. Real payment records live in your Stripe dashboard — this is
// just a convenient local copy of what's happened.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'sales.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return []; }
}
function save(d) { fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }

function record(sale) {
  const sales = load();
  sales.unshift({ ...sale, recordedAt: new Date().toISOString() });
  save(sales.slice(0, 1000)); // keep the log from growing forever
}
function list() { return load(); }

module.exports = { record, list };
