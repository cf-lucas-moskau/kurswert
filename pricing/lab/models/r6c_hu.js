const { makeRidge, C, combine } = require('../ridgeModel'); module.exports = makeRidge({ cols: combine(C.base, C.trim6, C.gen, C.batt, C.opts, (x) => ({ huNew: x.huNew })) });
