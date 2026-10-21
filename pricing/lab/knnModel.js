// Comparable-listings correction: price = linear(target) × exp(shrunk mean of the
// linear model's log residuals on the k most similar training cars of the same
// model). Mimics a dealer adjusting from nearby comps.
const { extra } = require('./feat2');
const { mean } = require('./lib');

function makeKnnResid(linear, o = {}) {
  const k = o.k || 15;
  const shrink = o.shrink ?? 10; // weight = k/(k+shrink)
  const w = { age: 1, km: 1, kw: 1, batt: 0.5, perf: 1, lr: 0.5, ...(o.w || {}) };
  const vec = (x) => [x.age / 2 * w.age, x.km / 0.5 * w.km, x.kw / 0.5 * w.kw, (x.batt || 0) / 10 * w.batt, x.perf * w.perf, x.lr * w.lr];
  return {
    fit(rows, ctx) {
      const lin = linear.fit(rows, ctx);
      const pts = rows.map((r) => {
        const x = extra(r);
        return { model: x.model, v: vec(x), res: Math.log(r.price) - Math.log(lin(r).price) };
      });
      return (r) => {
        const l = lin(r);
        const x = extra(r);
        const v = vec(x);
        const cand = pts.filter((p) => p.model === x.model)
          .map((p) => ({ d: p.v.reduce((s, a, i) => s + (a - v[i]) ** 2, 0), res: p.res }))
          .sort((a, b) => a.d - b.d).slice(0, k);
        // clip residuals so one mispriced comp cannot swing the estimate
        const adj = cand.length ? mean(cand.map((c) => Math.max(-0.15, Math.min(0.15, c.res)))) * (cand.length / (cand.length + shrink)) : 0;
        const price = l.price * Math.exp(adj);
        return { price, low: price * (l.low / l.price), high: price * (l.high / l.price) };
      };
    },
  };
}
module.exports = { makeKnnResid };
