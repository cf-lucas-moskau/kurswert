// Unit tests for listing loading / de-duplication. Run: node pricing/load_ads.test.js
const assert = require('assert');
const { dedupeRepeats, sameCar } = require('./load_ads');

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

const ad = (id, { attr, ...rest } = {}) => ({
  id, model: 'Model 3', price: { grossAmount: 28480 }, ...rest,
  attr: { fr: '03/2024', ml: '21.766 km', pw: '208 kW (283 PS)', loc: 'Sevilla', ...attr },
});

test('a dealer group posting one car at many branches counts once', () => {
  // Flexicar-style: same car, same price, one listing per branch city
  const ads = [ad('a', { attr: { loc: 'Sevilla' } }), ad('b', { attr: { loc: 'Oviedo' } }), ad('c', { attr: { loc: 'Zaragoza' } })];
  const out = dedupeRepeats(ads);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'a');
  assert.strictEqual(out[0].repeats, 2);
});
test('different cars with the same model and registration are kept', () => {
  const out = dedupeRepeats([ad('a'), ad('b', { attr: { ml: '40.000 km' } }), ad('c', { price: { grossAmount: 30000 } })]);
  assert.strictEqual(out.length, 3);
});
test('a listing without mileage or price is never merged', () => {
  const out = dedupeRepeats([ad('a', { attr: { ml: undefined } }), ad('b', { attr: { ml: undefined } })]);
  assert.strictEqual(out.length, 2);
});
test('sameCar tolerates small km and price differences across sites', () => {
  assert.ok(sameCar(ad('a'), ad('b', { attr: { ml: '21.900 km' }, price: { grossAmount: 28990 } })));
  assert.ok(!sameCar(ad('a'), ad('b', { price: { grossAmount: 31000 } })));
});

console.log(`\n${passed} passed`);
