// best ridge, trained on mobile.de + AutoScout24 (German ads), with an AS24
// indicator column so a systematic source offset is learned, not baked in.
const { makeRidge, C, combine } = require('../ridgeModel');
const { withAux } = require('../auxModel');
const src = (x) => ({ as24: +(x.source === 'autoscout24') });
module.exports = withAux(makeRidge({ cols: combine(C.base, C.trim6, C.gen, C.batt, C.opts, C.seller, src) }), { ctxKey: 'as24', pick: (r) => r.f.country === 'DE' });
