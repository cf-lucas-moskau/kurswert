// best ridge + ALL AutoScout24 ads (any country) with source and foreign flags
const { makeRidge, C, combine } = require('../ridgeModel');
const { withAux } = require('../auxModel');
const src = (x) => ({ as24: +(x.source === 'autoscout24'), foreign: x.foreign });
module.exports = withAux(makeRidge({ cols: combine(C.base, C.trim6, C.gen, C.batt, C.opts, C.seller, src) }), { ctxKey: 'as24', pick: () => true });
