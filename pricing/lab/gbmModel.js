// Pooled gradient-boosted trees on log price (pure JS, lib.gbmFit).
// opts: { gbm: {...gbmFit opts}, cols(x) -> {name: value}, mono: {name: -1|1},
//         region: apply PLZ-zone residual adjustment after the fit,
//         bandK: multiplier on the in-sample residual sigma for the ±1σ band }
const { gbmFit, median, mean } = require('./lib');
const { extra } = require('./feat2');

const MODELS = ['Model 3', 'Model Y', 'Model S', 'Model X'];
const defaultCols = (x) => ({
  m3: +(x.model === 'Model 3'), mY: +(x.model === 'Model Y'), mS: +(x.model === 'Model S'), mX: +(x.model === 'Model X'),
  age: x.age, km: x.km, kw: x.kw,
  awd: x.awd, perf: x.perf, plaid: x.plaid, lr: x.lr, srp: x.srp, sr: x.sr,
  highland: x.highland, juniper: x.juniper, refresh: x.refresh,
  batt: x.batt == null ? -1 : x.batt,
  freeSC: x.freeSC, fsd: x.fsd, seats7: x.seats7,
  private: x.private, owners: x.owners == null ? -1 : x.owners, huNew: x.huNew,
});

function makeGbm(o = {}) {
  const cols = o.cols || defaultCols;
  const mono = { age: -1, km: -1, ...(o.mono || {}) };
  return {
    fit(rows) {
      const xs = rows.map(extra);
      const names = Object.keys(cols(xs[0]));
      const X = xs.map((x) => Object.values(cols(x)));
      const y = rows.map((r) => Math.log(r.price));
      const model = gbmFit(X, y, { ...o.gbm, monotone: names.map((n) => mono[n] || 0) });
      const resid = y.map((v, i) => v - model.trainPred[i]);
      const region = {};
      if (o.region) {
        const byZ = {};
        xs.forEach((x, i) => { if (x.plzZone) (byZ[x.plzZone] = byZ[x.plzZone] || []).push(resid[i]); });
        for (const [z, rs] of Object.entries(byZ)) region[z] = median(rs) * (rs.length / (rs.length + 15));
      }
      const sig = {};
      for (const m of MODELS) {
        const rs = resid.filter((_, i) => xs[i].model === m);
        sig[m] = rs.length ? Math.sqrt(mean(rs.map((r) => r * r))) : 0.15;
      }
      const smear = o.smear ? mean(resid.map(Math.exp)) : 1;
      const p = (r) => {
        const x = extra(r);
        const lp = model.predict(Object.values(cols(x))) + (region[x.plzZone] || 0);
        const price = Math.exp(lp) * smear;
        const s = (sig[x.model] || 0.15) * (o.bandK || 1);
        return { price, low: price * Math.exp(-s), high: price * Math.exp(s), logBase: lp };
      };
      return p;
    },
  };
}

module.exports = { makeGbm, defaultCols };
