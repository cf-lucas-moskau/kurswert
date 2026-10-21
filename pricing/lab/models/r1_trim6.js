const { makeRidge, C, combine } = require('../ridgeModel');
module.exports = makeRidge({ cols: combine(C.base, C.trim6) });
