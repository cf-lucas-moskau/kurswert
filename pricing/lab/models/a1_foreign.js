const { makeRidge, C, combine } = require('../ridgeModel'); const { withAux } = require('../auxModel'); const { labels } = require('../data');
const clean = (r) => !r.label || (r.label.condition === 'clean' && !r.label.batteryIssue);
module.exports = withAux(makeRidge({ cols: combine(C.base, C.trim6, C.gen, C.batt, C.opts, C.seller, (x) => ({ foreign: x.foreign })) }), { pick: (r) => r.f.country !== 'DE' && clean(r) });
