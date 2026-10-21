// Train on extra (never-scored) listings too, with an indicator column so the
// model learns their price offset; predictions are made with the indicator at 0.
// pick(r) selects which aux rows to add; flag(x) is the offset indicator.
function withAux(maker, { pick, flagName = 'foreign', ctxKey = 'aux' }) {
  return {
    fit(rows, ctx) {
      const extraRows = (ctx[ctxKey] || []).filter(pick);
      return maker.fit([...rows, ...extraRows], ctx);
    },
  };
}
module.exports = { withAux };
