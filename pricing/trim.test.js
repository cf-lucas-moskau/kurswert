// Tests for the trim classifier. Run: node pricing/trim.test.js
const assert = require('assert');
const { classify, classifyListing } = require('./trim');

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

const car = (facts) => ({ model: 'Model 3', text: '', powerKw: null, reg: null, batteryKwh: null, drive: null, aiTrim: null, ...facts });
const pick = ({ trim, label, confidence, rule }) => ({ trim, label, confidence, rule });

test('Model 3 / Y trims named in the title', () => {
  assert.deepStrictEqual(pick(classify(car({ text: 'Tesla Model 3 Long Range Dual AWD', powerKw: 258, reg: 2021.3 }))),
    { trim: 'Long Range AWD', label: 'Long Range AWD', confidence: 'hoch', rule: 'text:long-range' });
  assert.deepStrictEqual(pick(classify(car({ text: 'Standard RWD Plus 60 kWh', powerKw: 175, reg: 2021.4, batteryKwh: 60 }))),
    { trim: 'RWD', label: 'RWD · 60 kWh', confidence: 'hoch', rule: 'text:standard-before-2025' });
  assert.deepStrictEqual(pick(classify(car({ model: 'Model Y', text: 'Model Y Performance', powerKw: 393, reg: 2023 }))),
    { trim: 'Performance', label: 'Performance', confidence: 'hoch', rule: 'text:performance' });
  assert.deepStrictEqual(pick(classify(car({ text: 'Gran Autonomía RWD', powerKw: 208, reg: 2023.4 }))),
    { trim: 'Long Range RWD', label: 'Long Range RWD', confidence: 'hoch', rule: 'text:long-range+rwd' });
  assert.strictEqual(classify(car({ model: 'Model Y', text: 'Hinterradantrieb - max. Reichweite', reg: 2024.7 })).trim, 'Long Range RWD');
});

test('a Long Range with the acceleration boost is not a Performance', () => {
  const c = classify(car({ text: 'Long Range AWD Acceleration Boost', powerKw: 324, reg: 2021 }));
  assert.deepStrictEqual([c.trim, c.rule], ['Long Range AWD', 'text:long-range']);
});

test('"Performance" next to another trim name is settled by the power', () => {
  // dealers title Long Ranges "Long Range AWD Performance"; 366 kW is the Long Range
  assert.deepStrictEqual(pick(classify(car({ text: 'Long Range AWD Performance (097)', powerKw: 366, reg: 2023 }))),
    { trim: 'Long Range AWD', label: 'Long Range AWD', confidence: 'hoch', rule: 'text:long-range+performance-by-power' });
  // Tesla's own 2019 name for the Performance, with its power
  assert.strictEqual(classify(car({ text: 'Long Range Performance AWD', powerKw: 377, reg: 2019.5 })).trim, 'Performance');
  // "Performance" wheels on a Standard Range Plus
  assert.strictEqual(classify(car({ text: 'SR+ 20Zoll Performance, Carbon', powerKw: 239, reg: 2022.8 })).trim, 'RWD');
  // truncated by the site
  assert.strictEqual(classify(car({ text: 'Allradantrieb mit Dualmotor Performa...', powerKw: 377, reg: 2019.9 })).trim, 'Performance');
});

test('the 2025 Standard is told apart from the old Standard Range', () => {
  assert.strictEqual(classify(car({ model: 'Model Y', text: 'Model Y Standard', reg: 2025.9 })).trim, 'Standard');
  assert.strictEqual(classify(car({ model: 'Model Y', text: 'Model Y Standard', reg: 2023 })).trim, 'RWD');
  assert.strictEqual(classify(car({ model: 'Model Y', text: 'Model Y Premium Hinterradantrieb', reg: 2026 })).trim, 'RWD');
  // a 2026 car called only "RWD" could be either: stays unknown
  assert.deepStrictEqual(pick(classify(car({ model: 'Model Y', text: 'Model Y RWD', powerKw: 220, reg: 2026.2 }))),
    { trim: 'unbekannt', label: 'unbekannt', confidence: 'keine', rule: 'no-signal' });
});

test('battery, drive and power decide when the text says nothing', () => {
  assert.deepStrictEqual(pick(classify(car({ text: 'Tesla Model 3', reg: 2021, batteryKwh: 55 }))),
    { trim: 'RWD', label: 'RWD · 55 kWh', confidence: 'mittel', rule: 'specs:battery<=64kWh' });
  assert.deepStrictEqual(pick(classify(car({ text: 'Tesla Model 3', reg: 2020.5, powerKw: 377 }))),
    { trim: 'Performance', label: 'Performance', confidence: 'mittel', rule: 'specs:power-377kW' });
  assert.strictEqual(classify(car({ model: 'Model Y', text: 'Model Y', reg: 2022.5, powerKw: 378 })).trim, 'Long Range AWD');
  // 208 kW is the RWD before 2023, but also the Long Range RWD after
  assert.strictEqual(classify(car({ text: 'Model 3', reg: 2022, powerKw: 208 })).trim, 'RWD');
  assert.strictEqual(classify(car({ text: 'Model 3', reg: 2023.6, powerKw: 208 })).trim, 'unbekannt');
  // LFP cells only went into the rear-drive cars
  assert.strictEqual(classify(car({ model: 'Model Y', text: 'PREMIUM LFP + MMX PACK, Allrad', reg: 2024.1, powerKw: 220 })).trim, 'RWD');
});

test('a power figure overrules a stray equipment word, not a trim name', () => {
  // "Allrad" from the equipment list on a 220 kW (RWD) Model Y
  assert.strictEqual(classify(car({ model: 'Model Y', text: 'Model Y, Allrad, Sitzheizung', reg: 2023, powerKw: 220 })).trim, 'RWD');
  assert.strictEqual(classify(car({ text: 'Standard Range Plus', reg: 2019.8, powerKw: 258 })).trim, 'RWD');
});

test('the AI label is used only when the listing text is silent, at medium confidence', () => {
  const c = classify(car({ text: 'Model 3 SRP neuer Akku', reg: 2021.2, aiTrim: 'Performance', powerKw: 225 }));
  assert.deepStrictEqual([c.trim, c.confidence], ['RWD', 'hoch']);
  const ai = classify(car({ text: 'Model 3 neuer Akku', reg: 2021.2, aiTrim: 'Standard Range Plus' }));
  assert.deepStrictEqual([ai.trim, ai.confidence, ai.rule], ['RWD', 'mittel', 'ai-label:standard-range']);
});

test('Model S / X battery badges, Raven and refresh', () => {
  const sx = (facts) => pick(classify(car({ model: 'Model S', ...facts })));
  assert.deepStrictEqual(sx({ text: 'Model S P90DL Ludicrous', reg: 2016.5, powerKw: 568 }),
    { trim: '90', label: 'P90DL', confidence: 'hoch', rule: 'text:badge-P90DL' });
  assert.deepStrictEqual(sx({ text: 'Model S 7sitzer ModelS85 -SC01', reg: 2014.4, powerKw: 270 }),
    { trim: '85', label: '85 kWh', confidence: 'hoch', rule: 'text:badge-85' });
  assert.strictEqual(sx({ text: '85P+ Free Supercharging', reg: 2015.2 }).label, 'P85+');
  assert.strictEqual(sx({ text: 'MODEL S 70 kWh Dual Motor', reg: 2016.6 }).label, '70D');
  assert.strictEqual(sx({ text: '75D Allradantrieb Performance', reg: 2017.7 }).label, '75D'); // there was no P75D
  assert.strictEqual(sx({ text: '100D Ludicrous Performance', reg: 2019.4 }).label, 'P100D');
  assert.strictEqual(sx({ text: '100 km Reichweite', reg: 2016 }).trim, 'unbekannt');
  assert.strictEqual(sx({ text: 'Dual Motor Long Range', reg: 2020.1, powerKw: 390 }).trim, 'Raven Long Range');
  assert.strictEqual(sx({ text: 'Long Range Plus Raven Ludicrous', reg: 2019.9 }).trim, 'Raven Performance');
  assert.strictEqual(sx({ text: 'Long Range', reg: 2023, powerKw: 493 }).trim, 'Long Range');
  // the refresh has no battery badges; "100D" there is habit
  assert.strictEqual(sx({ text: 'MODEL X 100D - Dual Motor', reg: 2025.3, powerKw: 510 }).trim, 'Long Range');
  // "plaid" seats on a 493 kW Long Range
  assert.strictEqual(sx({ text: 'Long Range* Yoke* 6-Seats plaid', reg: 2023.8, powerKw: 493 }).trim, 'Long Range');
  assert.deepStrictEqual(sx({ text: 'Model S', reg: 2023.5, powerKw: 750 }),
    { trim: 'Plaid', label: 'Plaid', confidence: 'mittel', rule: 'specs:power-750kW' });
  assert.strictEqual(sx({ text: 'Palladium, Allrad', reg: 2023.7, powerKw: 670 }).trim, 'unbekannt');
  assert.strictEqual(sx({ text: 'Performance GRATIS LADEN', reg: 2014.3 }).label, 'P85');
});

test('Cybertruck and Roadster, and a model read from the title', () => {
  assert.deepStrictEqual(pick(classify(car({ model: 'Andere', text: 'Tesla Andere CYBERBEAST-CYBERTRUCK 844PS', powerKw: 621 }))),
    { trim: 'Cyberbeast', label: 'Cyberbeast', confidence: 'hoch', rule: 'text:cyberbeast' });
  assert.strictEqual(classify(car({ model: 'Andere', text: 'Cybertruck' })).model, 'Cybertruck');
  assert.strictEqual(classify(car({ model: 'Roadster', text: 'Roadster V2.5 - HEATED SEATS' })).trim, '2.5');
});

test('a listing maps to facts from its search fields, detail page and label', () => {
  const ad = { id: 1, model: 'Model 3', shortTitle: 'Tesla Model 3', subTitle: 'Basis', attr: { pw: '225 kW (306 PS)', fr: '07/2020' } };
  const detail = { attributes: [{ tag: 'trimLine', value: 'Basis RWD' }, { tag: 'batteryCapacity', value: '55 kWh' }], features: ['ABS', 'Heckantrieb'] };
  assert.deepStrictEqual(pick(classifyListing(ad, detail, { trueTrim: 'Long Range', trimConfidence: 'high' })),
    { trim: 'RWD', label: 'RWD · 55 kWh', confidence: 'hoch', rule: 'text:rwd' });
  // without the detail page only "Basis" and 225 kW remain; a low-confidence label is ignored
  assert.deepStrictEqual(pick(classifyListing(ad, null, { trueTrim: 'Long Range', trimConfidence: 'low' })),
    { trim: 'RWD', label: 'RWD', confidence: 'mittel', rule: 'specs:power-225kW' });
});

console.log(`\n${passed} passed`);
