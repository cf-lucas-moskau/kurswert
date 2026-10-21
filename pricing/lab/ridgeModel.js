// Configurable per-model ridge in log price (generalizes the current engine).
// opts:
//   cols(x) -> { name: value } numeric design for one car (x = feat2.extra row)
//   lambda, robust: 'drop' (2.5σ drop + refit, as engine) | 'huber' (IRLS) | 'none'
//   region: true -> PLZ-zone median residual adjustment shrunk n/(n+15)
//   pooled: true -> one pooled fit with model dummies + model×(age,km) interactions
const { ridge, makeScaler, dot, median, mean } = require('./lib');
const { extra } = require('./feat2');

const BIG = ['Model 3', 'Model Y', 'Model S', 'Model X'];

function fitBlock(xs, y, cols, o) {
  const names = Object.keys(cols(xs[0]));
  const raw = xs.map((x) => [1, ...Object.values(cols(x))]);
  const mask = raw[0].map((_, j) => j > 0 && new Set(raw.map((r) => r[j])).size > 2);
  const scale = makeScaler(raw, mask);
  const X = raw.map(scale);
  let w = null;
  let coef = ridge(X, y, o.lambda);
  let resid = y.map((v, i) => v - dot(X[i], coef));
  let sigma = Math.sqrt(mean(resid.map((r) => r * r)));
  let keep = y.map(() => true);
  if (o.robust === 'drop') {
    keep = resid.map((r) => Math.abs(r) <= 2.5 * sigma);
    const Xk = X.filter((_, i) => keep[i]);
    coef = ridge(Xk, y.filter((_, i) => keep[i]), o.lambda);
  } else if (o.robust === 'huber') {
    for (let it = 0; it < 8; it++) {
      const s = 1.4826 * median(resid.map(Math.abs)) || sigma;
      const c = (o.huberK || 1.345) * s;
      w = resid.map((r) => (Math.abs(r) <= c ? 1 : c / Math.abs(r)));
      coef = ridge(X, y, o.lambda, w);
      resid = y.map((v, i) => v - dot(X[i], coef));
    }
    keep = resid.map((r) => Math.abs(r) <= 2.5 * 1.4826 * median(resid.map(Math.abs)));
  }
  resid = y.map((v, i) => v - dot(X[i], coef));
  const rk = resid.filter((_, i) => keep[i]);
  sigma = Math.sqrt(mean(rk.map((r) => r * r)));
  const smear = o.smear === 'none' ? 1 : mean(rk.map(Math.exp));
  return { names, coef, scale, sigma, smear, cols };
}

function makeRidge(o) {
  o = { lambda: 1, robust: 'drop', region: true, ...o };
  return {
    fit(rows) {
      const xs = rows.map((r) => extra(r));
      const y = rows.map((r) => Math.log(r.price));
      const blocks = {};
      if (!o.pooled) {
        for (const m of BIG) {
          const idx = xs.map((x, i) => (x.model === m ? i : -1)).filter((i) => i >= 0);
          if (idx.length >= 40) blocks[m] = fitBlock(idx.map((i) => xs[i]), idx.map((i) => y[i]), o.cols, o);
        }
      }
      // pooled fallback (and the main model when o.pooled): model dummies
      const pcols = (x) => {
        const d = {};
        for (const m of BIG) d[`is_${m}`] = +(x.model === m);
        const c = o.cols(x);
        if (o.pooled) for (const m of BIG) { d[`age_${m}`] = x.model === m ? x.age : 0; d[`km_${m}`] = x.model === m ? x.km : 0; }
        return { ...d, ...c };
      };
      const pooled = fitBlock(xs, y, pcols, o);
      const blockOf = (x) => blocks[x.model] || pooled;
      const base = (x, b) => dot(b.scale([1, ...Object.values(b.cols(x))]), b.coef);
      let region = {};
      if (o.region) {
        const byZ = {};
        xs.forEach((x, i) => { if (x.plzZone) (byZ[x.plzZone] = byZ[x.plzZone] || []).push(y[i] - base(x, blockOf(x))); });
        for (const [z, rs] of Object.entries(byZ)) region[z] = median(rs) * (rs.length / (rs.length + 15));
      }
      const predictor = (r) => {
        const x = extra(r);
        const b = blockOf(x);
        const lp = base(x, b) + (region[x.plzZone] || 0);
        const price = Math.exp(lp) * b.smear;
        return { price, low: price * Math.exp(-b.sigma), high: price * Math.exp(b.sigma), logBase: lp };
      };
      predictor.blocks = blocks;
      return predictor;
    },
  };
}

// handy column sets
const C = {
  base: (x) => ({ age: x.age, age2: x.age * x.age, km: x.km, km2: x.km * x.km, kw: x.kw }),
  trim4: (x) => ({ awd: x.awd, perf: x.perf, plaid: x.plaid, lr: x.lr }),
  trim6: (x) => ({ awd: x.awd, perf: x.perf, plaid: x.plaid, lr: x.lr, srp: x.srp, sr: x.sr }),
  gen: (x) => ({ highland: x.highland, juniper: x.juniper, refresh: x.refresh }),
  batt: (x) => ({ batt: x.batt == null ? 0 : x.batt / 100, battMissing: +(x.batt == null) }),
  opts: (x) => ({ freeSC: x.freeSC, fsd: x.fsd, seats7: x.seats7 }),
  opts2: (x) => ({ eap: x.eap, hw: x.hw, ahk: x.ahk }),
  seller: (x) => ({ private: x.private, owners: x.owners == null ? 1 : x.owners, ownersMissing: +(x.owners == null), huNew: x.huNew }),
  inter: (x) => ({ ageKm: x.age * x.km }),
};
const combine = (...fs) => (x) => Object.assign({}, ...fs.map((f) => f(x)));

module.exports = { makeRidge, C, combine };
