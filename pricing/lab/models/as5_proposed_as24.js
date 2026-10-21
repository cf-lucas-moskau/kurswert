// the integration candidate (proposed engine) trained on mobile.de + German AS24
// ads. The engine has no source column, so this tests "just merge them".
const { train, predict } = require('../proposed/engine');
const { featurize } = require('../proposed/features');
const fz = (r) => featurize(r.ad, undefined, r.label);
module.exports = {
  fit(rows, ctx) {
    const extra = (ctx.as24 || []).filter((r) => r.f.country === 'DE');
    const model = train([...rows, ...extra].map(fz).filter(Boolean));
    return (r) => { const v = predict(model, fz(r)); return { price: v.marketPrice, low: v.low, high: v.high }; };
  },
};
