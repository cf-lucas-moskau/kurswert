// the CV winner (e3) with AutoScout24 German ads added to training + source flag
const { makeRidge, C, combine } = require('../ridgeModel');
const { makeGbm, defaultCols } = require('../gbmModel');
const { makeKnnResid } = require('../knnModel');
const { makeEnsemble } = require('../ensemble');
const { withAux } = require('../auxModel');
const src = (x) => ({ as24: +(x.source === 'autoscout24') });
const ridge = makeRidge({ cols: combine(C.base, C.trim6, C.gen, C.batt, C.opts, C.seller, src) });
const gbm = makeGbm({ cols: combine(defaultCols, src), gbm: { nTrees: 400, lr: 0.05, depth: 4, minLeaf: 8, loss: 'huber', huberDelta: 0.08 } });
module.exports = withAux(makeEnsemble([makeKnnResid(ridge, { k: 15 }), gbm], [0.7, 0.3]), { ctxKey: 'as24', pick: (r) => r.f.country === 'DE' });
