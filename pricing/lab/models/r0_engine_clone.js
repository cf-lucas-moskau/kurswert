// sanity: ridgeModel reproducing the engine's feature set (should ≈ baseline)
const { makeRidge, C, combine } = require('../ridgeModel');
module.exports = makeRidge({ cols: combine(C.base, C.trim4) });
