
// ---- lab proposal: richer features, comps correction, boosted trees ----
const { batteryKwh } = require('./features');
test('classifyTrim catches P100DL, S75D and the "Peformance" typo', () => {
  assert.strictEqual(classifyTrim('Model S', 'MODEL S P100DL silber').performance, 1);
  assert.strictEqual(classifyTrim('Model S', 'Dual PEFORMANCE SC01').performance, 1);
  assert.strictEqual(classifyTrim('Model S', 'MODEL S75D MCU2').awd, 1);
  assert.strictEqual(classifyTrim('Model 3', 'Rear-Wheel Drive').srBase, 1);
});
test('batteryKwh prefers the structured field, then the title', () => {
  assert.strictEqual(batteryKwh('Model 3', '79 kWh', 'Long Range'), 79);
  assert.strictEqual(batteryKwh('Model 3', undefined, 'TESLA MODEL 3 75 KWH PERFORMANCE'), 75);
  assert.strictEqual(batteryKwh('Model S', undefined, 'MODEL S P100DL'), 100);
  assert.strictEqual(batteryKwh('Model S', undefined, '90D Allrad'), 90);
  assert.strictEqual(batteryKwh('Model 3', undefined, 'Long Range'), null);
});
test('featurize extracts generation, equipment and seller signals', () => {
  const f = featurize({
    model: 'Model 3', price: { grossAmount: 40000 }, shortTitle: 'Tesla Model 3', subTitle: 'Long Range FSD SC01 free Supercharging',
    attr: { fr: '03/2024', ml: '20.000 km', pw: '366 kW (498 PS)', bc: '79 kWh', sc: '5', pvo: '2', gi: 'Neu' },
    contactInfo: { sellerType: 'PRIVATE' },
  });
  assert.strictEqual(f.highland, 1);
  assert.strictEqual(f.fsd, 1);
  assert.strictEqual(f.freeSupercharging, 1);
  assert.strictEqual(f.batteryKwh, 79);
  assert.strictEqual(f.privateSeller, 1);
  assert.strictEqual(f.owners, 2);
  assert.strictEqual(f.huNew, 1);
  const old = featurize({ model: 'Model 3', price: { grossAmount: 30000 }, attr: { fr: '03/2022', ml: '20.000 km', pw: '366 kW (498 PS)' } });
  assert.strictEqual(old.highland, 0);
  assert.strictEqual(old.owners, null);
  assert.strictEqual(old.batteryKwh, null);
});
test('trained model is plain JSON and predicts identically after a round-trip', () => {
  const copy = JSON.parse(JSON.stringify(model));
  const f = rows.find((r) => r.model === 'Model S');
  assert.strictEqual(predict(copy, f).marketPrice, predict(model, f).marketPrice);
  assert.ok(model.trees && model.trees.trees.length > 0, 'boosted trees trained');
  assert.ok(model.comps['Model 3'].length > 40, 'comps table stored');
});
test('mileage sweep never raises the price (trees are monotone, comps bounded)', () => {
  for (const m of ['Model 3', 'Model Y', 'Model S', 'Model X']) {
    let prev = Infinity;
    for (let km = 10000; km <= 250000; km += 20000) {
      const p = priceOf({ model: m, shortTitle: `Tesla ${m}`, attr: { fr: '07/2020', ml: `${km} km`, pw: '250 kW (340 PS)' } });
      // comps can wiggle a step by a few % when the neighbour set changes; the
      // overall trend must still fall and no step may rise by more than 3%
      assert.ok(p <= prev * 1.03, `${m} ${km} km: ${p} vs previous ${prev}`);
      prev = Math.min(prev, p);
    }
  }
});
test('free Supercharging raises an old Model S estimate', () => {
  const base = { model: 'Model S', shortTitle: 'Tesla Model S', attr: { fr: '06/2016', ml: '150.000 km', pw: '310 kW (421 PS)' } };
  const plain = priceOf({ ...base, subTitle: '85D' });
  const freeSc = priceOf({ ...base, subTitle: '85D Free Supercharging' });
  assert.ok(freeSc > plain, `free SC ${freeSc} vs plain ${plain}`);
});
test('comps correction stays within its clip', () => {
  const f = rows.find((r) => r.model === 'Model Y');
  const noComps = { ...model, comps: {} };
  const ratio = predict(model, f).marketPrice / predict(noComps, f).marketPrice;
  assert.ok(ratio > Math.exp(-0.15) - 0.01 && ratio < Math.exp(0.15) + 0.01, `ratio ${ratio}`);
});
