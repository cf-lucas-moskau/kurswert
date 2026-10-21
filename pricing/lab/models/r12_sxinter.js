const { makeRidge, C, combine } = require('../ridgeModel'); const sx = (x) => ({ ageRefresh: x.age * x.refresh, agePerf: x.age * x.perf, battAge: (x.batt || 0) / 100 * x.age, kwAge: x.kw * x.age });
module.exports = makeRidge({ cols: combine(C.base, C.trim6, C.gen, C.batt, C.opts, C.seller, sx) });
