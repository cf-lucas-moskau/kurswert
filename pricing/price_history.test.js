// Unit tests for the price-history tracker. Run: node pricing/price_history.test.js
// Uses a temp file (PRICE_HISTORY_FILE) so real data/ is untouched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `price_history_test_${process.pid}.json`);
process.env.PRICE_HISTORY_FILE = TMP;
if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
const hist = require('./price_history');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

const ad = (id, price) => ({ id, price: { grossAmount: price } });

test('first observation creates one entry', () => {
  hist.observe([ad(1, 30000)], '2026-07-01');
  assert.deepStrictEqual(hist.historyFor(1), [['2026-07-01', 30000]]);
});

test('re-observing the same price adds nothing', () => {
  hist.observe([ad(1, 30000)], '2026-07-05');
  assert.strictEqual(hist.historyFor(1).length, 1);
});

test('a price change appends a dated entry', () => {
  hist.observe([ad(1, 28500)], '2026-07-10');
  assert.deepStrictEqual(hist.historyFor(1), [['2026-07-01', 30000], ['2026-07-10', 28500]]);
});

test('dropInfo reports last drop and total drop from the initial price', () => {
  hist.observe([ad(1, 27000)], '2026-07-15');
  const d = hist.dropInfo(1);
  assert.strictEqual(d.drops, 2);
  assert.strictEqual(d.lastDropDate, '2026-07-15');
  assert.strictEqual(d.previousPrice, 28500);
  assert.strictEqual(d.firstPrice, 30000);
  assert.strictEqual(d.totalDropPct, -10); // 30000 -> 27000
});

test('a price increase is recorded but not counted as a drop', () => {
  hist.observe([ad(2, 20000)], '2026-07-01');
  hist.observe([ad(2, 21000)], '2026-07-05');
  assert.strictEqual(hist.historyFor(2).length, 2);
  assert.strictEqual(hist.dropInfo(2), null); // net movement is up, no drop signal
});

test('increase then bigger drop still yields drop info', () => {
  hist.observe([ad(2, 19000)], '2026-07-12');
  const d = hist.dropInfo(2);
  assert.strictEqual(d.drops, 1);
  assert.strictEqual(d.totalDropPct, -5); // 20000 -> 19000
});

test('a cosmetic cut under 1% is not a price-drop signal', () => {
  // 16,999 -> 16,990 is a listing refresh, not a motivated seller
  hist.observe([ad(60, 16999)], '2026-07-01');
  hist.observe([ad(60, 16990)], '2026-07-05');
  assert.strictEqual(hist.historyFor(60).length, 2);
  assert.strictEqual(hist.dropInfo(60), null);
});

test('unknown id has no history and no drops', () => {
  assert.deepStrictEqual(hist.historyFor(999), []);
  assert.strictEqual(hist.dropInfo(999), null);
});

test('ads without a price are ignored', () => {
  hist.observe([{ id: 3 }, { id: 4, price: {} }], '2026-07-01');
  assert.deepStrictEqual(hist.historyFor(3), []);
  assert.deepStrictEqual(hist.historyFor(4), []);
});

test('a cut on the first-seen day keeps the baseline price', () => {
  hist.observe([ad(5, 25000)], '2026-07-20');
  hist.observe([ad(5, 23000)], '2026-07-20'); // cut later the same day
  assert.deepStrictEqual(hist.historyFor(5), [['2026-07-20', 25000], ['2026-07-20', 23000]]);
  assert.strictEqual(hist.dropInfo(5).totalDropPct, -8);
});

test('same-day flip-flop after the baseline collapses to the latest price', () => {
  hist.observe([ad(6, 30000)], '2026-07-01');
  hist.observe([ad(6, 29000)], '2026-07-05');
  hist.observe([ad(6, 28000)], '2026-07-05');
  assert.deepStrictEqual(hist.historyFor(6), [['2026-07-01', 30000], ['2026-07-05', 28000]]);
});

test('observe returns counts and skips the write when nothing changed', () => {
  const before = fs.statSync(TMP).mtimeMs;
  const r = hist.observe([ad(6, 28000)], '2026-07-06'); // same price again
  assert.strictEqual(r.changes, 0);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(fs.statSync(TMP).mtimeMs, before);
});

test('history persists across a reload', () => {
  const fresh = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.deepStrictEqual(fresh['1'].map((e) => e[1]), [30000, 28500, 27000]);
});

fs.unlinkSync(TMP);
console.log(`\n${passed} passed`);
