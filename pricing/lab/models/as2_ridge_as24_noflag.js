const { makeRidge, C, combine } = require('../ridgeModel');
const { withAux } = require('../auxModel');
module.exports = withAux(makeRidge({ cols: combine(C.base, C.trim6, C.gen, C.batt, C.opts, C.seller) }), { ctxKey: 'as24', pick: (r) => r.f.country === 'DE' });
