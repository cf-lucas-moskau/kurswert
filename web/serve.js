// Server for the dealer dashboard. Serves this directory, the JSON feeds from
// the data dir (src/paths.js), the seen-state API and the offer-sending
// automation. Run: node web/serve.js
//   http://localhost:8080 (override with HOST and PORT)
// Offer sending is on only when bound to localhost, since anyone who can reach
// the server could otherwise message sellers. OFFERS=1 or OFFERS=0 overrides.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { dataFile } = require('../src/paths');
const Seen = require('./seen');

const DIR = __dirname;
const ROOT = path.join(__dirname, '..');
const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 8080;
const OFFERS = process.env.OFFERS ? process.env.OFFERS === '1' : ['localhost', '127.0.0.1', '::1'].includes(HOST);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
const FEEDS = new Set(['/valuations.json', '/newest.json', '/dealer.json']);
const SEEN_FILE = dataFile('seen.json');

const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

function readBody(req, limit, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > limit) req.destroy();
  });
  req.on('end', () => {
    try { cb(JSON.parse(body || '{}')); } catch { cb({}); }
  });
}

// Seen state is created on first use, starting today, so only cars that
// arrive from then on count as new. One process owns the file; writes go
// through a temp file so a crash never leaves it half-written.
function loadSeen() {
  if (fs.existsSync(SEEN_FILE)) return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  const state = Seen.create(new Date().toISOString().slice(0, 10));
  saveSeen(state);
  return state;
}
function saveSeen(state) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE + '.tmp', JSON.stringify(state));
  fs.renameSync(SEEN_FILE + '.tmp', SEEN_FILE);
}
let seen = loadSeen();

// POST /api/seen  { ids: [...] } -> { added, total }
function markSeen(req, res) {
  readBody(req, 1e6, (p) => {
    if (!Array.isArray(p.ids)) return json(res, 400, { error: 'ids must be an array' });
    const r = Seen.markSeen(seen, p.ids, new Date().toISOString());
    if (r.added) { seen = r.state; saveSeen(seen); }
    json(res, 200, { added: r.added, total: Object.keys(seen.ids).length });
  });
}

// POST /api/send-offer  { id, offer, send }
// Runs pricing/send_offer.js. Dry-run unless send===true (which sets SEND=1 and
// actually submits the mobile.de contact form). Streams the script output back.
function sendOffer(req, res) {
  readBody(req, 1e5, (p) => {
    if (!p.id) return json(res, 400, { error: 'missing id' });
    const args = ['pricing/send_offer.js', String(p.id)];
    if (p.offer) args.push(String(p.offer));
    const env = { ...process.env, ...(p.send ? { SEND: '1' } : {}) };
    const child = spawn('node', args, { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => json(res, 200, { code, dryRun: !p.send, output: out.slice(-4000) }));
  });
}

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/api/config') return json(res, 200, { offers: OFFERS });
    if (rel === '/api/seen') {
      if (req.method === 'POST') return markSeen(req, res);
      return json(res, 200, seen);
    }
    if (rel === '/api/send-offer') {
      if (!OFFERS) return json(res, 403, { error: 'offer sending is disabled on this server' });
      if (req.method === 'POST') return sendOffer(req, res);
    }
    const file = FEEDS.has(rel) ? dataFile(rel.slice(1)) : path.join(DIR, rel === '/' ? 'index.html' : rel);
    if (!FEEDS.has(rel) && !file.startsWith(DIR)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(PORT, HOST, () => console.log(`dealer dashboard: http://${HOST}:${PORT} (offers ${OFFERS ? 'on' : 'off'}, data ${dataFile('')})`));
