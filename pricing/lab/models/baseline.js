// The current engine (frozen copy of pricing/engine.js + features.js taken at
// the start of the lab run), unchanged.
const { train, predict } = require('../baseline/engine');

module.exports = {
  name: 'baseline',
  fit(rows) {
    const model = train(rows.map((r) => r.f));
    return (r) => {
      const v = predict(model, r.f);
      return { price: v.marketPrice, low: v.low, high: v.high };
    };
  },
};
