// Fixed evaluation harness for the pricing lab.
//
//   node pricing/lab/harness.js                    # CV every candidate in models/
//   node pricing/lab/harness.js baseline v2        # CV selected candidates
//   node pricing/lab/harness.js --holdout baseline final   # score the untouched holdout
//   REPEATS=2 node pricing/lab/harness.js ...      # quicker, noisier
//
// CV: grouped 10-fold (near-duplicate listings stay in one fold), repeated 5x
// with fixed seeds, on the dev split (85% of clean German listings). The 15%
// holdout is only scored with --holdout, once, for the final comparison.
//
// A candidate module exports { name, fit(trainRows, ctx) -> predict(row) ->
// { price, low?, high? } }. Rows carry { ad, label, f, price, model }. ctx.aux
// holds non-scored listings (foreign, damaged) a candidate may train on.
const fs = require('fs');
const path = require('path');
const data = require('./data');

const K = 10;
const REPEATS = +(process.env.REPEATS || 5);
const SEEDS = [11, 22, 33, 44, 55].slice(0, REPEATS);
const MODELS = ['Model 3', 'Model Y', 'Model S', 'Model X'];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function summarize(preds) {
  // preds: [{ model, price, pred, low, high }]
  const m = (ps) => {
    const ape = ps.map((p) => Math.abs(p.pred - p.price) / p.price);
    const signed = ps.map((p) => (p.pred - p.price) / p.price);
    const banded = ps.filter((p) => p.low != null && p.high != null);
    return {
      n: ps.length,
      medAPE: median(ape),
      meanAPE: mean(ape),
      w5: mean(ape.map((a) => (a <= 0.05 ? 1 : 0))),
      w10: mean(ape.map((a) => (a <= 0.1 ? 1 : 0))),
      bias: median(signed), // + = we over-predict the asking price
      cover: banded.length ? mean(banded.map((p) => (p.price >= p.low && p.price <= p.high ? 1 : 0))) : null,
    };
  };
  const out = { all: m(preds) };
  for (const mod of MODELS) out[mod] = m(preds.filter((p) => p.model === mod));
  return out;
}

function runFold(cand, train, test) {
  const ctx = { aux: data.aux, as24: data.as24.length ? data.as24For(test) : [] };
  const predict = cand.fit(train, ctx);
  return test.map((r) => {
    const p = predict(r);
    return { id: r.id, model: r.model, price: r.price, pred: p.price, low: p.low, high: p.high };
  });
}

function cv(cand) {
  const reps = [];
  const allPreds = [];
  for (const seed of SEEDS) {
    const fs_ = data.folds(data.dev, K, seed);
    const preds = [];
    for (let i = 0; i < K; i++) {
      const train = fs_.filter((_, j) => j !== i).flat();
      preds.push(...runFold(cand, train, fs_[i]));
    }
    reps.push(summarize(preds));
    allPreds.push(...preds);
  }
  // average each metric across repeats; also report the spread of overall medAPE
  const avg = {};
  for (const key of Object.keys(reps[0])) {
    avg[key] = {};
    for (const met of Object.keys(reps[0][key])) {
      const vals = reps.map((r) => r[key][met]).filter((v) => v != null);
      avg[key][met] = vals.length ? mean(vals) : null;
    }
  }
  const meds = reps.map((r) => r.all.medAPE);
  avg.all.medSd = Math.sqrt(mean(meds.map((v) => (v - mean(meds)) ** 2)));
  return { metrics: avg, preds: allPreds };
}

function holdout(cand) {
  const preds = runFold(cand, data.dev, data.holdout);
  return { metrics: summarize(preds), preds };
}

const pct = (v, d = 1) => (v == null || Number.isNaN(v) ? '  -  ' : `${(v * 100).toFixed(d)}%`);
function fmt(name, m) {
  const a = m.all;
  const per = MODELS.map((k) => `${k.slice(-1)} ${pct(m[k].medAPE)}`).join('  ');
  return `${name.padEnd(28)} med ${pct(a.medAPE, 2)}${a.medSd != null ? `±${(a.medSd * 100).toFixed(2)}` : ''}  mean ${pct(a.meanAPE)}  ±5 ${pct(a.w5, 0)}  ±10 ${pct(a.w10, 0)}  bias ${pct(a.bias)}  cover ${pct(a.cover, 0)} | ${per}`;
}

function loadCandidate(name) {
  return require(path.join(__dirname, 'models', `${name}.js`));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const doHoldout = args.includes('--holdout');
  let names = args.filter((a) => !a.startsWith('--'));
  if (!names.length) names = fs.readdirSync(path.join(__dirname, 'models')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  console.log(`${data.universe.length} clean DE listings: dev ${data.dev.length}, holdout ${data.holdout.length}; ${doHoldout ? 'HOLDOUT' : `CV ${REPEATS}x${K}-fold grouped`}`);
  const results = {};
  for (const n of names) {
    const cand = loadCandidate(n);
    const t0 = Date.now();
    const res = doHoldout ? holdout(cand) : cv(cand);
    results[n] = res.metrics;
    console.log(`${fmt(n, res.metrics)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, doHoldout ? 'holdout.json' : process.env.CV_GROUP === 'seller' ? 'cv_seller.json' : 'cv.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...results }, null, 1));
}

module.exports = { cv, holdout, summarize, fmt, median, mean };
