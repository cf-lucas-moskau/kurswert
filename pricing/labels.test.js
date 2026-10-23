// Tests for the label queue and result merge. Run: node pricing/labels.test.js
// Uses a temp KURSWERT_DATA, so real data is untouched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kurswert-labels-'));
process.env.KURSWERT_DATA = DIR;
const { QUEUE, RESULTS_DIR, needsLabel, facts, mergeResults, writeQueue } = require('./labels');

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

const good = { trueTrim: 'Long Range', trimConfidence: 'high', condition: 'clean', batteryIssue: false, isImport: false, commercialUse: false, priceCaveats: [] };
const ad = { id: 52269086356512, model: 'Model Y', shortTitle: 'Tesla Model Y', subTitle: 'Dual AWD LR', attr: { pw: '378 kW (514 PS)', fr: '05/2023', ml: '67.576 km' } };
const detail = { htmlDescription: '<p>Unfallfrei&nbsp;<b>Scheckheft</b></p>', attributes: [{ tag: 'damageCondition', value: 'Unfallfrei' }] };

test('a car with a description and no label needs one; gone or labeled cars do not', () => {
  assert.strictEqual(needsLabel(ad, { [ad.id]: detail }, {}), true);
  assert.strictEqual(needsLabel(ad, { [ad.id]: detail }, { [ad.id]: good }), false);
  assert.strictEqual(needsLabel(ad, { [ad.id]: { ...detail, gone: true } }, {}), false);
  assert.strictEqual(needsLabel(ad, {}, {}), false);
});

test('the queue holds the same facts the API prompt reads', () => {
  writeQueue([facts(ad, detail)]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(QUEUE, 'utf8')), [{
    id: 52269086356512, model: 'Model Y', title: 'Tesla Model Y Dual AWD LR', power: '378 kW (514 PS)',
    firstRegistration: '05/2023', mileage: '67.576 km', damageCondition: 'Unfallfrei', description: 'Unfallfrei Scheckheft',
  }]);
  writeQueue([]);
  assert.strictEqual(fs.existsSync(QUEUE), false);
});

test('valid results merge, malformed or unknown ones are rejected, files are consumed', () => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'chunk-1.json'), JSON.stringify({
    1: good,
    2: { ...good, condition: 'kaputt' },
    3: { ...good, batteryIssue: 'no' },
    999: good,
  }));
  fs.writeFileSync(path.join(RESULTS_DIR, 'chunk-2.json'), 'not json');
  const labels = {};
  const r = mergeResults(labels, new Set(['1', '2', '3']));
  assert.deepStrictEqual(labels, { 1: { labeledBy: 'claude-code-subagent', ...good } });
  assert.deepStrictEqual(r, { merged: 1, rejected: ['2: condition', '3: batteryIssue', '999: unknown id', 'chunk-2.json: not JSON'] });
  assert.deepStrictEqual(fs.readdirSync(RESULTS_DIR), ['chunk-2.json']);
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed`);
