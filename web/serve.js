// Server for the dealer dashboard. Serves this directory and exposes one API
// endpoint that triggers the offer-sending automation. Run: node web/serve.js
//   http://localhost:8080 (override with PORT)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8080;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };

// POST /api/send-offer  { id, offer, send }
// Runs pricing/send_offer.js. Dry-run unless send===true (which sets SEND=1 and
// actually submits the mobile.de contact form). Streams the script output back.
function sendOffer(req, res) {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let p;
    try { p = JSON.parse(body || '{}'); } catch { p = {}; }
    if (!p.id) { res.writeHead(400).end(JSON.stringify({ error: 'missing id' })); return; }
    const args = ['pricing/send_offer.js', String(p.id)];
    if (p.offer) args.push(String(p.offer));
    const env = { ...process.env, ...(p.send ? { SEND: '1' } : {}) };
    const child = spawn('node', args, { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code, dryRun: !p.send, output: out.slice(-4000) }));
    });
  });
}

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/send-offer') return sendOffer(req, res);
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(DIR, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(DIR)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`dealer dashboard: http://localhost:${PORT}`));
