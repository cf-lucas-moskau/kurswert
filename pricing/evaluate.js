// Evaluation harness for the pricing engine. Run: node pricing/evaluate.js
//
// Three independent checks:
//   1. k-fold cross-validation: train on 90%, predict the held-out 10%, measure
//      how far our market price lands from the actual asking price. This is the
//      honest accuracy number (no data leakage).
//   2. Rating alignment: mobile.de publishes its own verdict per listing
//      ("Sehr guter Preis" ... "Hoher Preis"). Our deltaPct (asking vs our market
//      price) should increase monotonically across those buckets. This validates
//      the engine against a fully independent valuation.
//   3. Per-model accuracy breakdown.
const fs = require('fs');
const path = require('path');
const { train, predict } = require('./engine');
const { featurize } = require('./features');

// INCLUDE_AS24=0 evaluates on mobile.de alone, for before/after comparisons
const { ads } = require('./load_ads').loadAds({ includeAs24: process.env.INCLUDE_AS24 !== '0' });
const labelsPath = path.join(__dirname, '..', 'data', 'labels.json');
const labels = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, 'utf8')) : {};
const allRows = ads.map((a) => featurize(a, undefined, labels[a.id])).filter(Boolean).filter((r) => r.price > 0);
// the market model is clean German resale value; evaluate it on its own domain
const rows = allRows.filter(require('./load_ads').makeTrainingFilter(ads, labels));
console.log(`${rows.length} clean German listings (of ${allRows.length} usable, ${ads.length} total)\n`);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// deterministic shuffle (seeded LCG) so results are reproducible across runs
function seededShuffle(arr, seed = 42) {
  const a = [...arr];
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- 1. k-fold cross-validation ----
function crossValidate(k = 10) {
  const shuffled = seededShuffle(rows);
  const folds = Array.from({ length: k }, () => []);
  shuffled.forEach((r, i) => folds[i % k].push(r));
  const apes = [];
  const byModel = {};
  const within10 = [];
  for (let i = 0; i < k; i++) {
    const testSet = folds[i];
    const trainSet = folds.filter((_, j) => j !== i).flat();
    const model = train(trainSet);
    for (const r of testSet) {
      const v = predict(model, r);
      const ape = Math.abs(v.marketPrice - r.price) / r.price;
      apes.push(ape);
      within10.push(ape <= 0.1 ? 1 : 0);
      (byModel[r.model] = byModel[r.model] || []).push(ape);
    }
  }
  console.log(`== ${k}-fold cross-validation (predicted market price vs actual asking) ==`);
  console.log(`  median abs % error : ${(median(apes) * 100).toFixed(1)}%`);
  console.log(`  mean abs % error   : ${(mean(apes) * 100).toFixed(1)}%`);
  console.log(`  within ±10%        : ${(mean(within10) * 100).toFixed(0)}% of listings`);
  console.log('  by model:');
  for (const [m, xs] of Object.entries(byModel).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${m.padEnd(10)} n=${String(xs.length).padStart(4)}  median APE ${(median(xs) * 100).toFixed(1)}%`);
  }
  console.log();
  return median(apes);
}

// ---- 2. alignment with mobile.de's own price rating ----
function ratingAlignment() {
  const model = train(rows);
  const order = ['Sehr guter Preis', 'Guter Preis', 'Fairer Preis', 'Erhöhter Preis', 'Hoher Preis'];
  const buckets = {};
  ads.forEach((a) => {
    const f = featurize(a, undefined, labels[a.id]);
    if (!f || !(f.price > 0)) return;
    const label = a.priceRating?.ratingLabel;
    if (!order.includes(label)) return;
    const v = predict(model, f);
    const deltaPct = ((a.price.grossAmount - v.marketPrice) / v.marketPrice) * 100;
    (buckets[label] = buckets[label] || []).push(deltaPct);
  });
  console.log('== Alignment with mobile.de price rating (independent ground truth) ==');
  console.log('   our delta% = asking vs our market price; should rise across buckets');
  let prev = -Infinity;
  let monotonic = true;
  for (const label of order) {
    const xs = buckets[label] || [];
    if (!xs.length) continue;
    const md = median(xs);
    const flag = md >= prev ? '' : '  <-- OUT OF ORDER';
    if (md < prev) monotonic = false;
    prev = md;
    console.log(`   ${label.padEnd(18)} n=${String(xs.length).padStart(4)}  median delta ${md >= 0 ? '+' : ''}${md.toFixed(1)}%${flag}`);
  }
  console.log(`   monotonic: ${monotonic ? 'YES (engine agrees with mobile.de ordering)' : 'NO'}\n`);
  return monotonic;
}

const medAPE = crossValidate(10);
const aligned = ratingAlignment();

console.log('== Verdict ==');
console.log(`  cross-val median APE ${(medAPE * 100).toFixed(1)}% ${medAPE < 0.12 ? 'PASS' : 'CHECK'} (target <12%)`);
console.log(`  rating alignment      ${aligned ? 'PASS' : 'FAIL'}`);
process.exit(medAPE < 0.15 && aligned ? 0 : 1);
