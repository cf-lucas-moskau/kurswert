// Tests for the nightly orchestration. Run: node pricing/nightly.test.js
// Steps are faked or dry-run against a temp KURSWERT_DATA; nothing is scraped.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { STEPS, runNightly, summarize } = require('./nightly');
const { loadEnvLocal } = require('../src/env');

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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kurswert-nightly-'));
const steps = [{ name: 'reset' }, { name: 'scrape' }, { name: 'train' }];
let clock = 0;
const now = () => `2026-10-24T0${clock++}:00:00.000Z`;
// records which steps ran; failOn makes that step fail once
function recorder(failOn) {
  const ran = [];
  return { ran, exec: async (s) => { ran.push(s.name); if (s.name === failOn) { failOn = null; return false; } return true; } };
}

(async () => {
  await test('the real pipeline runs every stage once, vetting after value-newest', () => {
    assert.deepStrictEqual(STEPS.map((s) => s.name),
      ['reset-mobile', 'scrape', 'reset-as24', 'scrape-as24', 'value-newest', 'details', 'label', 'train']);
  });

  await test('a run executes all steps in order and is marked finished', async () => {
    const statePath = path.join(tmp(), 'state.json');
    const r = recorder();
    const { ok, state } = await runNightly({ steps, statePath, exec: r.exec, log: () => {}, now });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(r.ran, ['reset', 'scrape', 'train']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).completed, ['reset', 'scrape', 'train']);
    assert.ok(state.finishedAt);
  });

  await test('after a failure the rerun resumes at the failed step and never repeats the reset', async () => {
    const statePath = path.join(tmp(), 'state.json');
    const r = recorder('scrape');
    const first = await runNightly({ steps, statePath, exec: r.exec, log: () => {}, now });
    assert.strictEqual(first.ok, false);
    const second = await runNightly({ steps, statePath, exec: r.exec, log: () => {}, now });
    assert.strictEqual(second.ok, true);
    assert.deepStrictEqual(r.ran, ['reset', 'scrape', 'scrape', 'train']);
    assert.strictEqual(second.state.startedAt, first.state.startedAt);
  });

  await test('a finished run is followed by a fresh one', async () => {
    const statePath = path.join(tmp(), 'state.json');
    const r = recorder();
    const a = await runNightly({ steps, statePath, exec: r.exec, log: () => {}, now });
    const b = await runNightly({ steps, statePath, exec: r.exec, log: () => {}, now });
    assert.deepStrictEqual(r.ran, ['reset', 'scrape', 'train', 'reset', 'scrape', 'train']);
    assert.notStrictEqual(b.state.startedAt, a.state.startedAt);
  });

  await test('--fresh restarts an unfinished run from the top', async () => {
    const statePath = path.join(tmp(), 'state.json');
    const r = recorder('train');
    await runNightly({ steps, statePath, exec: r.exec, log: () => {}, now });
    await runNightly({ steps, statePath, exec: r.exec, log: () => {}, now, fresh: true });
    assert.deepStrictEqual(r.ran, ['reset', 'scrape', 'train', 'reset', 'scrape', 'train']);
  });

  await test('the summary counts new cars per site and deals since the run started', () => {
    const car = (id, source, firstSeen, asking) =>
      ({ id, source, firstSeen, asking, marketPrice: 30000, flagged: false, extrapolated: false, corrections: [] });
    const listings = [
      car(1, 'mobile.de', '2026-10-24T02:10:00.000Z', 20000), // new deal
      car(2, 'mobile.de', '2026-10-24T02:20:00.000Z', 29000), // new, no deal
      { ...car(3, 'mobile.de', '2026-10-24T02:30:00.000Z', 20000), pendingLabel: true }, // new but unvetted
      car('as24:a', 'autoscout24', '2026-10-24T03:00:00.000Z', 31000),
      car(4, 'mobile.de', '2026-10-21', 20000), // old deal
    ];
    assert.strictEqual(summarize({ listings, calibration: null, startedAt: '2026-10-24T02:00:00.000Z', queued: 1 }),
      'nightly 2026-10-24T02:00: 3 new on mobile.de, 1 new on AutoScout24, 2 deals (1 among new cars), 1 cars queued for labeling');
  });

  await test('--dry-run logs every step in order and changes no data', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'raw_ads.json'), '[]');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'nightly.js'), '--dry-run'], {
      env: { ...process.env, KURSWERT_DATA: dir }, encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const log = fs.readFileSync(path.join(dir, 'nightly.log'), 'utf8');
    const planned = [...log.matchAll(/would (.+)/g)].map((m) => m[1]);
    assert.deepStrictEqual(planned, [
      'delete raw_ads.json, progress.json', 'run node src/scrape.js',
      'delete raw_ads_as24.json, progress_as24.json', 'run node src/scrape_autoscout.js',
      'run node pricing/value_newest.js', 'run node src/fetch_details.js', 'run node pricing/label.js', 'run node pricing/train.js',
    ]);
    assert.match(log, /nightly \S+: 0 new on mobile.de, 0 new on AutoScout24, 0 deals \(0 among new cars\), 0 cars queued for labeling/);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['nightly.log', 'raw_ads.json']);
  });

  await test('.env.local fills unset variables and never overrides the environment', () => {
    const file = path.join(tmp(), '.env.local');
    fs.writeFileSync(file, '# key for nightly labeling\nKURSWERT_TEST_A=sk-test-123\nexport KURSWERT_TEST_B="quoted value"\nKURSWERT_TEST_C=from-file\nnot a line\n');
    process.env.KURSWERT_TEST_C = 'from-env';
    assert.deepStrictEqual(loadEnvLocal(file), ['KURSWERT_TEST_A', 'KURSWERT_TEST_B']);
    assert.deepStrictEqual([process.env.KURSWERT_TEST_A, process.env.KURSWERT_TEST_B, process.env.KURSWERT_TEST_C], ['sk-test-123', 'quoted value', 'from-env']);
    assert.deepStrictEqual(loadEnvLocal(path.join(tmp(), 'missing')), []);
  });

  console.log(`\n${passed} passed`);
})();
