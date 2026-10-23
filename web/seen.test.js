// Tests for the seen state and its server API. Run: node web/seen.test.js
// The server runs against a temp KURSWERT_DATA, so real data is untouched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Seen = require('./seen');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const car = (id, firstSeen) => ({ id, firstSeen });

function startServer(dataDir, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'serve.js')], {
      env: { ...process.env, KURSWERT_DATA: dataDir, HOST: host, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.once('data', () => resolve(child));
    child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}
const stop = (child) => new Promise((r) => { child.once('exit', r); child.kill(); });
const api = (port, method, body) =>
  fetch(`http://127.0.0.1:${port}/api/seen`, { method, body: body && JSON.stringify(body) }).then((r) => r.json());

(async () => {
  await test('a car first seen on or after the start day is unseen', () => {
    const s = Seen.create('2026-10-23');
    assert.strictEqual(Seen.isUnseen(s, car(1, '2026-10-23')), true);
    assert.strictEqual(Seen.isUnseen(s, car(2, '2026-10-24T03:12:00.000Z')), true);
  });

  await test('the backlog from before the start day is not unseen', () => {
    const s = Seen.create('2026-10-23');
    assert.strictEqual(Seen.isUnseen(s, car(1, '2026-10-21')), false);
    assert.strictEqual(Seen.isUnseen(s, car(2, null)), false);
  });

  await test('marking a car seen removes it from the unseen set', () => {
    const { state, added } = Seen.markSeen(Seen.create('2026-10-23'), [52269086356512], '2026-10-24T08:00:00.000Z');
    assert.strictEqual(added, 1);
    assert.strictEqual(Seen.isUnseen(state, car(52269086356512, '2026-10-24')), false);
    assert.strictEqual(Seen.isUnseen(state, car(52267759983680, '2026-10-24')), true);
  });

  await test('marking again keeps the first seen time and adds nothing', () => {
    const first = Seen.markSeen(Seen.create('2026-10-23'), ['as24:abc'], '2026-10-24T08:00:00.000Z').state;
    const again = Seen.markSeen(first, ['as24:abc'], '2026-10-25T09:00:00.000Z');
    assert.strictEqual(again.added, 0);
    assert.deepStrictEqual(again.state.ids, { 'as24:abc': '2026-10-24T08:00:00.000Z' });
  });

  await test('malformed ids are ignored', () => {
    const r = Seen.markSeen(Seen.create('2026-10-23'), ['', '../x', 'a b', '7'], '2026-10-24T08:00:00.000Z');
    assert.deepStrictEqual(Object.keys(r.state.ids), ['7']);
  });

  await test('marking does not mutate the previous state', () => {
    const s = Seen.create('2026-10-23');
    Seen.markSeen(s, ['1'], '2026-10-24T08:00:00.000Z');
    assert.deepStrictEqual(s.ids, {});
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kurswert-seen-'));
  const port = 18000 + (process.pid % 1000);
  await test('the server stores seen cars in the data dir and keeps them across a restart', async () => {
    let server = await startServer(dir, port);
    try {
      const fresh = await api(port, 'GET');
      assert.strictEqual(fresh.since, new Date().toISOString().slice(0, 10));
      assert.deepStrictEqual(await api(port, 'POST', { ids: ['111', '222'] }), { added: 2, total: 2 });
      assert.deepStrictEqual(await api(port, 'POST', { ids: ['222', '333'] }), { added: 1, total: 3 });
    } finally {
      await stop(server);
    }
    server = await startServer(dir, port);
    try {
      const after = await api(port, 'GET');
      assert.deepStrictEqual(Object.keys(after.ids).sort(), ['111', '222', '333']);
      assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8')).ids).sort(), ['111', '222', '333']);
    } finally {
      await stop(server);
    }
  });

  await test('the server rejects a body without an ids array', async () => {
    const server = await startServer(dir, port);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/seen`, { method: 'POST', body: '{"ids":"111"}' });
      assert.strictEqual(r.status, 400);
    } finally {
      await stop(server);
    }
  });

  await test('offer sending is refused when bound to anything but localhost', async () => {
    // an IPv4-mapped loopback address stays private but is not a localhost name
    const server = await startServer(dir, port, '::ffff:127.0.0.1');
    try {
      assert.deepStrictEqual(await fetch(`http://127.0.0.1:${port}/api/config`).then((r) => r.json()), { offers: false });
      const r = await fetch(`http://127.0.0.1:${port}/api/send-offer`, { method: 'POST', body: '{"id":"1"}' });
      assert.strictEqual(r.status, 403);
    } finally {
      await stop(server);
    }
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})();
