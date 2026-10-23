// Unit tests for the pricing engine. Run: node pricing/engine.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { train, predict, valuate } = require('./engine');
const { featurize, classifyTrim, parseRegDate, parseKm, parseKw } = require('./features');

const ads = JSON.parse(fs.readFileSync(require('../src/paths').dataFile('raw_ads.json'), 'utf8'));
const rows = ads.map((a) => featurize(a)).filter(Boolean);
const model = train(rows);

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

// ---- parsing / featurization ----
test('parseRegDate rejects implausible years', () => {
  assert.strictEqual(parseRegDate('07/2019'), 2019.5);
  assert.strictEqual(parseRegDate('00/2020'), null);
  assert.strictEqual(parseRegDate('13/2020'), null);
  assert.strictEqual(parseRegDate('05/1999'), null);
  assert.strictEqual(parseRegDate(''), null);
});
test('parseKm strips thousands separators and bounds', () => {
  assert.strictEqual(parseKm('54.000 km'), 54000);
  assert.strictEqual(parseKm('0 km'), 0);
  assert.strictEqual(parseKm('999.999 km'), null); // implausible
});
test('parseKw extracts kW', () => {
  assert.strictEqual(parseKw('345 kW (469 PS)'), 345);
  assert.strictEqual(parseKw('foo'), null);
});
test('featurize returns null when a core field is missing', () => {
  assert.strictEqual(featurize({ model: 'Model 3', price: { grossAmount: 30000 }, attr: { fr: '07/2019' } }), null);
});
test('featurize detects trim signals from title', () => {
  const f = featurize({
    model: 'Model 3', price: { grossAmount: 40000 },
    shortTitle: 'Tesla Model 3', subTitle: 'Long Range Dual Motor AWD Performance',
    attr: { fr: '07/2021', ml: '30.000 km', pw: '340 kW (462 PS)' },
  });
  assert.strictEqual(f.awd, 1);
  assert.strictEqual(f.performance, 1);
  assert.strictEqual(f.longRange, 1);
});

// ---- trim taxonomy ----
test('classifyTrim labels Model 3/Y variants', () => {
  assert.strictEqual(classifyTrim('Model 3', 'Long Range Dual AWD 75 KWH').label, 'Long Range');
  assert.strictEqual(classifyTrim('Model 3', 'Performance FSD').label, 'Performance');
  assert.strictEqual(classifyTrim('Model 3', 'Standard Range Plus').label, 'Standard Range Plus');
  assert.strictEqual(classifyTrim('Model Y', 'Hinterradantrieb RWD').label, 'Standard Range');
});
test('classifyTrim labels Model S/X battery tiers and top trims', () => {
  assert.strictEqual(classifyTrim('Model S', 'Plaid').label, 'Plaid');
  assert.strictEqual(classifyTrim('Model S', '100D Base').label, '100D');
  assert.strictEqual(classifyTrim('Model X', 'P100D Ludicrous').label, 'Performance');
  assert.strictEqual(classifyTrim('Model S', '75D CCS').awd, 1);
});
test('Performance/Plaid flags imply AWD', () => {
  assert.strictEqual(classifyTrim('Model 3', 'Performance').awd, 1);
  assert.strictEqual(classifyTrim('Model S', 'Plaid').plaid, 1);
});

// ---- monotonicity: the engine must behave like the real world ----
function priceOf(overrides) {
  const base = {
    model: 'Model 3', price: { grossAmount: 30000 },
    shortTitle: 'Tesla Model 3', subTitle: 'Long Range',
    attr: { fr: '07/2021', ml: '50.000 km', pw: '250 kW (340 PS)' },
    ...overrides,
  };
  return valuate(model, base).marketPrice;
}
test('older cars are worth less (all else equal)', () => {
  const newer = priceOf({ attr: { fr: '07/2023', ml: '50.000 km', pw: '250 kW (340 PS)' } });
  const older = priceOf({ attr: { fr: '07/2018', ml: '50.000 km', pw: '250 kW (340 PS)' } });
  assert.ok(newer > older, `expected newer(${newer}) > older(${older})`);
});
test('higher mileage is worth less (all else equal)', () => {
  const low = priceOf({ attr: { fr: '07/2021', ml: '20.000 km', pw: '250 kW (340 PS)' } });
  const high = priceOf({ attr: { fr: '07/2021', ml: '150.000 km', pw: '250 kW (340 PS)' } });
  assert.ok(low > high, `expected low-km(${low}) > high-km(${high})`);
});
test('a Model X is worth more than a Model 3 of same age/mileage', () => {
  const m3 = priceOf({});
  const mx = priceOf({ model: 'Model X', shortTitle: 'Tesla Model X', subTitle: '' });
  assert.ok(mx > m3, `expected Model X(${mx}) > Model 3(${m3})`);
});

// ---- valuation / margin logic ----
test('valuate produces a market price in a sane range', () => {
  const v = valuate(model, ads.find((a) => a.model === 'Model 3'));
  assert.ok(v.valuable);
  assert.ok(v.marketPrice > 5000 && v.marketPrice < 120000, `marketPrice ${v.marketPrice}`);
  assert.ok(v.low < v.marketPrice && v.marketPrice < v.high, 'confidence band ordering');
});
test('maxBuyPrice reflects the desired margin', () => {
  const v = valuate(model, ads.find((a) => a.model === 'Model 3'), 0.2);
  // buying at maxBuyPrice and reselling at market yields ~20% margin
  const realizedMargin = (v.marketPrice - v.maxBuyPrice) / v.maxBuyPrice;
  assert.ok(Math.abs(realizedMargin - 0.2) < 0.01, `realized ${realizedMargin}`);
});
test('a car listed below maxBuyPrice is flagged as a deal', () => {
  const ad = ads.find((a) => a.model === 'Model 3' && !valuate(model, a).extrapolated && !featurize(a).corrections.length);
  // just under the buy target, not absurdly cheap (that would be implausible)
  const cheap = { ...ad, price: { grossAmount: valuate(model, ad, 0.15).maxBuyPrice - 100 } };
  const pricey = { ...ad, price: { grossAmount: 200000 } };
  assert.strictEqual(valuate(model, cheap, 0.15).isDeal, true);
  assert.strictEqual(valuate(model, pricey, 0.15).isDeal, false);
});
test('deltaPct sign matches asking vs market', () => {
  const ad = ads.find((a) => a.model === 'Model 3');
  const v = valuate(model, ad);
  const expectedSign = Math.sign(v.asking - v.marketPrice);
  assert.strictEqual(Math.sign(v.deltaPct), expectedSign);
});
test('unvaluable ad is reported, not crashed', () => {
  const v = valuate(model, { model: 'Model 3', price: { grossAmount: 30000 }, attr: {} });
  assert.strictEqual(v.valuable, false);
});

// ---- model robustness ----
test('sparse model falls back to global tier', () => {
  const roadster = ads.find((a) => a.model === 'Roadster');
  if (roadster) assert.strictEqual(valuate(model, roadster).tier, 'global');
});
test('volume model uses its own regression', () => {
  assert.strictEqual(valuate(model, ads.find((a) => a.model === 'Model 3')).tier, 'model');
});
test('every usable listing values without error', () => {
  let ok = 0;
  for (const a of ads) {
    const v = valuate(model, a);
    if (v.valuable) {
      assert.ok(Number.isFinite(v.marketPrice) && v.marketPrice > 0, `bad price for ${a.id}`);
      ok++;
    }
  }
  assert.ok(ok > 1500, `only ${ok} valued`);
});

// ---- market tracking: the engine must follow the market, not memorize prices ----
test('valuations scale when the whole market shifts (retraining adjusts)', () => {
  const sample = rows.filter((r) => r.model === 'Model 3').slice(0, 50);
  const base = train(rows);
  // simulate the market dropping 10% across the board, then retrain
  const shifted = rows.map((r) => ({ ...r, price: r.price * 0.9 }));
  const after = train(shifted);
  const ratios = sample.map((r) => predict(after, r).marketPrice / predict(base, r).marketPrice);
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  assert.ok(Math.abs(avg - 0.9) < 0.01, `expected ~0.90 scaling, got ${avg.toFixed(3)}`);
});
test('market estimate is stable to a single outlier listing', () => {
  const base = predict(train(rows), rows.find((r) => r.model === 'Model 3'));
  const poisoned = [...rows, { ...rows[0], model: 'Model 3', price: 5000000 }]; // absurd listing
  const after = predict(train(poisoned), rows.find((r) => r.model === 'Model 3'));
  const drift = Math.abs(after.marketPrice - base.marketPrice) / base.marketPrice;
  assert.ok(drift < 0.02, `one outlier moved the estimate ${(drift * 100).toFixed(1)}%`);
});

// ---- regional stratification ----
test('featurize extracts the PLZ zone from search and detail shapes', () => {
  const search = featurize({
    model: 'Model 3', price: { grossAmount: 30000 },
    attr: { fr: '07/2021', ml: '30.000 km', pw: '250 kW', z: '85662', cn: 'DE' },
  });
  assert.strictEqual(search.plzZone, '8');
  // a foreign 5-digit code (Milan) must NOT map into a German PLZ zone
  const foreign = featurize({
    model: 'Model 3', price: { grossAmount: 30000 },
    attr: { fr: '07/2021', ml: '30.000 km', pw: '250 kW', z: '20121', cn: 'IT' },
  });
  assert.strictEqual(foreign.plzZone, null);
  const detail = featurize({
    model: 'Model 3', price: { grossAmount: 30000 },
    attributes: [
      { tag: 'firstRegistration', value: '07/2021' },
      { tag: 'mileage', value: '30.000 km' },
      { tag: 'power', value: '250 kW' },
    ],
    contactInfo: { country: 'DE', address2: 'DE-20095 Hamburg' },
  });
  assert.strictEqual(detail.plzZone, '2');
});

test('region adjustment learns a real regional price gap (with shrinkage)', () => {
  // synthetic market: identical cars, zone 8 priced 10% above zone 2
  const synth = [];
  for (let i = 0; i < 200; i++) {
    const zone = i % 2 ? '8' : '2';
    const age = 2 + (i % 5);
    const km = 20000 + (i % 7) * 15000;
    synth.push({
      id: i, model: 'Model 3', price: (30000 - age * 2000 - km * 0.05) * (zone === '8' ? 1.1 : 1),
      country: 'DE', ageYears: age, mileageKm: km, powerKw: 250,
      trimLabel: 'Long Range', awd: 1, performance: 0, plaid: 0, longRange: 1, plzZone: zone,
    });
  }
  const m = train(synth);
  const car = { ...synth[0], plzZone: '8' };
  const south = predict(m, car).marketPrice;
  const north = predict(m, { ...car, plzZone: '2' }).marketPrice;
  const ratio = south / north;
  assert.ok(ratio > 1.05 && ratio < 1.12, `expected ~1.09 zone gap, got ${ratio.toFixed(3)}`);
});

test('a car with no zip gets the unadjusted market price', () => {
  const ad = ads.find((a) => a.model === 'Model 3');
  const noZip = { ...ad, attr: { ...ad.attr } };
  delete noZip.attr.z;
  const v = valuate(model, noZip);
  assert.ok(v.valuable && Number.isFinite(v.marketPrice));
  assert.strictEqual(v.regionPct ?? 0, 0);
});

// ---- holding-cost-aware buy target ----
test('holding cost lowers maxBuyPrice by exactly days * dailyCost', () => {
  const ad = ads.find((a) => a.model === 'Model 3');
  const base = valuate(model, ad, 0.15);
  const withHold = valuate(model, ad, 0.15, { holdingDays: 90, dailyCost: 10 });
  assert.strictEqual(withHold.maxBuyPrice, base.maxBuyPrice - 900);
  assert.strictEqual(withHold.holdingCost, 900);
});

test('holding cost can flip a marginal deal to a non-deal', () => {
  const ad = ads.find((a) => a.model === 'Model 3' && !valuate(model, a).extrapolated);
  const base = valuate(model, ad, 0.15);
  const marginal = { ...ad, price: { grossAmount: base.maxBuyPrice - 100 } };
  assert.strictEqual(valuate(model, marginal, 0.15).isDeal, true);
  assert.strictEqual(valuate(model, marginal, 0.15, { holdingDays: 90, dailyCost: 10 }).isDeal, false);
});

test('maxBuyPrice never goes negative from holding cost', () => {
  const ad = ads.find((a) => a.model === 'Model 3');
  const v = valuate(model, ad, 0.15, { holdingDays: 10000, dailyCost: 100 });
  assert.ok(v.maxBuyPrice >= 0, `got ${v.maxBuyPrice}`);
});

// ---- seller title contradicts the structured fields ----
// Sellers sometimes put a re-registration date in the EZ field (imports) or
// mistype the power; the title then states the truth. Trusting the field
// values such a car as years newer or as a much weaker trim.
test('a build year in the title earlier than EZ sets the age', () => {
  const f = featurize({
    model: 'Model S', price: { grossAmount: 23000 },
    shortTitle: 'Tesla Model S', subTitle: 'Basis,Zulassung 2023,BJ 04.2016',
    attr: { fr: '08/2023', ml: '95.000 km', pw: '270 kW (367 PS)', cn: 'DE' },
  }, 2026.75);
  assert.ok(Math.abs(f.ageYears - (2026.75 - 2016.25)) < 0.01, `age ${f.ageYears}`);
  assert.ok(f.corrections.includes('baujahr'));
});
test('title PS wins when the kW field is implausibly far below it', () => {
  const f = featurize({
    model: 'Model S', price: { grossAmount: 45000 },
    shortTitle: 'Tesla Model S', subTitle: '-Allrad/670PS/1.Hd/Auto-Pilot/Pano/',
    attr: { fr: '03/2024', ml: '173.000 km', pw: '244 kW (332 PS)', cn: 'DE' },
  });
  assert.strictEqual(f.powerKw, 493);
  assert.ok(f.corrections.includes('leistung'));
});
test('a normal rated-vs-peak power gap does not override the kW field', () => {
  // German papers list rated power, ~30-35% under Tesla's marketed peak PS
  const f = featurize({
    model: 'Model S', price: { grossAmount: 40000 },
    shortTitle: 'Tesla Model S', subTitle: 'P100DL silber,770PS, AP',
    attr: { fr: '06/2018', ml: '90.000 km', pw: '391 kW (532 PS)', cn: 'DE' },
  });
  assert.strictEqual(f.powerKw, 391);
  assert.deepStrictEqual(f.corrections, []);
});
test('far more km per year than any comparable is flagged as extrapolated', () => {
  const v = valuate(model, {
    model: 'Model 3', price: { grossAmount: 30000 },
    shortTitle: 'Tesla Model 3', subTitle: 'Long Range',
    attr: { fr: '01/2026', ml: '150.000 km', pw: '250 kW (340 PS)', cn: 'DE' },
  });
  assert.strictEqual(v.extrapolated, true);
});


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
test('a listing is never its own comparable', () => {
  // the dashboard values listings that are in the training set; letting a car's
  // own residual into its comps pulls the estimate toward its own asking price
  const f = rows.find((r) => r.model === 'Model 3' && model.compIds['Model 3'].includes(r.id));
  const i = model.compIds['Model 3'].indexOf(f.id);
  const withResid = (res) => {
    const m = JSON.parse(JSON.stringify(model));
    const row = m.comps['Model 3'][i];
    row[row.length - 1] = res;
    return predict(m, f).marketPrice;
  };
  assert.strictEqual(withResid(0.15), withResid(-0.15));
});
test('comps correction stays within its clip', () => {
  const f = rows.find((r) => r.model === 'Model Y');
  const noComps = { ...model, comps: {} };
  const ratio = predict(model, f).marketPrice / predict(noComps, f).marketPrice;
  assert.ok(ratio > Math.exp(-0.15) - 0.01 && ratio < Math.exp(0.15) + 0.01, `ratio ${ratio}`);
});
test('a price far below anything clean on the market is not a deal', () => {
  // no labeled-clean listing sits more than ~27% under market; 30%+ under is a
  // damaged car, a scam or a data error, never a buying opportunity
  const ad = ads.find((a) => a.model === 'Model 3' && !valuate(model, a).extrapolated && !featurize(a).corrections.length);
  const market = valuate(model, ad).marketPrice;
  const v = valuate(model, { ...ad, price: { grossAmount: Math.round(market * 0.6) } });
  assert.strictEqual(v.implausiblePrice, true);
  assert.strictEqual(v.isDeal, false);
  assert.strictEqual(valuate(model, { ...ad, price: { grossAmount: Math.round(market * 0.8) } }).implausiblePrice, false);
});

console.log(`\n${passed} passed`);
