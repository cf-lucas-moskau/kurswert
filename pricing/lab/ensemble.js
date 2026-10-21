// Combinators: weighted geometric-mean ensemble, and "ridge + boosted residuals".
const { gbmFit, mean } = require('./lib');
const { extra } = require('./feat2');
const { defaultCols } = require('./gbmModel');

function makeEnsemble(parts, weights) {
  return {
    fit(rows, ctx) {
      const ps = parts.map((p) => p.fit(rows, ctx));
      return (r) => {
        const outs = ps.map((p) => p(r));
        const lp = outs.reduce((s, o, i) => s + weights[i] * Math.log(o.price), 0);
        const ll = outs.reduce((s, o, i) => s + weights[i] * Math.log(o.low / o.price), 0);
        const lh = outs.reduce((s, o, i) => s + weights[i] * Math.log(o.high / o.price), 0);
        const price = Math.exp(lp);
        return { price, low: price * Math.exp(ll), high: price * Math.exp(lh) };
      };
    },
  };
}

// fit the linear model, then boost shallow monotone trees on its in-sample
// log residuals: the linear part extrapolates sanely, trees fix local shape
function makeHybrid(linear, o = {}) {
  const cols = o.cols || defaultCols;
  return {
    fit(rows, ctx) {
      const lin = linear.fit(rows, ctx);
      const xs = rows.map(extra);
      const names = Object.keys(cols(xs[0]));
      const X = xs.map((x) => Object.values(cols(x)));
      const y = rows.map((r) => Math.log(r.price));
      const init = rows.map((r) => Math.log(lin(r).price));
      const mono = { age: -1, km: -1, ...(o.mono || {}) };
      const g = gbmFit(X, y, { nTrees: 200, lr: 0.05, depth: 3, minLeaf: 10, loss: 'huber', huberDelta: 0.08, ...o.gbm, init, monotone: names.map((n) => mono[n] || 0) });
      return (r) => {
        const l = lin(r);
        const adj = g.predict(Object.values(cols(extra(r))));
        const price = Math.exp(Math.log(l.price) + adj);
        return { price, low: price * (l.low / l.price), high: price * (l.high / l.price) };
      };
    },
  };
}

module.exports = { makeEnsemble, makeHybrid };
