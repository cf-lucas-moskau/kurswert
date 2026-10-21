// The integration candidate: pricing/lab/proposed/{engine,features,gbm}.js,
// i.e. exactly what proposal.patch puts into pricing/. Featurizes with the
// proposed features.js (the lab rows carry baseline features, so re-featurize).
const { train, predict } = require('../proposed/engine');
const { featurize } = require('../proposed/features');
const fz = (r) => featurize(r.ad, undefined, r.label);
module.exports = {
  name: 'proposed',
  fit(rows) {
    const model = train(rows.map(fz));
    return (r) => {
      const v = predict(model, fz(r));
      return { price: v.marketPrice, low: v.low, high: v.high };
    };
  },
};
