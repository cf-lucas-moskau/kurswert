// Paired bootstrap on the holdout: how sure are we that candidate B beats A?
//   node pricing/lab/holdout_bootstrap.js baseline proposed
const h = require('./harness');
const { rng } = require('./data');
const [a, b] = process.argv.slice(2);
const A = h.holdout(require(`./models/${a}`)).preds;
const B = h.holdout(require(`./models/${b}`)).preds;
const ape = (p) => Math.abs(p.pred - p.price) / p.price;
const r = rng(7);
const groups = [['all', () => true], ...['Model 3', 'Model Y', 'Model S', 'Model X'].map((m) => [m, (p) => p.model === m])];
for (const [name, sel] of groups) {
  const idx = A.map((p, i) => (sel(p) ? i : -1)).filter((i) => i >= 0);
  const dMed = [], dMean = [];
  for (let k = 0; k < 2000; k++) {
    const s = idx.map(() => idx[Math.floor(r() * idx.length)]);
    dMed.push(h.median(s.map((i) => ape(B[i]))) - h.median(s.map((i) => ape(A[i]))));
    dMean.push(h.mean(s.map((i) => ape(B[i]))) - h.mean(s.map((i) => ape(A[i]))));
  }
  const ci = (xs) => { const s = xs.sort((x, y) => x - y); return `[${(s[50] * 100).toFixed(2)}, ${(s[1949] * 100).toFixed(2)}]`; };
  const better = idx.filter((i) => ape(B[i]) < ape(A[i])).length;
  console.log(`${name.padEnd(8)} n=${idx.length}  Δmedian APE 95% CI ${ci(dMed)}  Δmean APE 95% CI ${ci(dMean)}  B closer on ${better}/${idx.length}`);
}
