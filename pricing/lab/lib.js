// Small dependency-free numeric toolkit for the lab: ridge regression and a
// histogram gradient-boosted tree regressor with optional monotone constraints.

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[p][col])) p = r;
    if (Math.abs(M[p][col]) < 1e-12) continue;
    [M[col], M[p]] = [M[p], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f) for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(M[i][i]) < 1e-12 ? 0 : row[n] / M[i][i]));
}

// weighted ridge; column 0 is the unpenalized intercept. lambda may be a number
// or a per-column array.
function ridge(X, y, lambda, w = null) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    const wi = w ? w[i] : 1;
    for (let a = 0; a < p; a++) {
      const v = wi * xi[a];
      b[a] += v * y[i];
      for (let c = a; c < p; c++) A[a][c] += v * xi[c];
    }
  }
  for (let a = 0; a < p; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
  for (let a = 1; a < p; a++) A[a][a] += Array.isArray(lambda) ? lambda[a] : lambda;
  return solve(A, b);
}

// standardizer for the columns flagged in `scaleMask`
function makeScaler(X, scaleMask) {
  const k = X[0].length;
  const mu = new Array(k).fill(0);
  const sd = new Array(k).fill(1);
  for (let j = 0; j < k; j++) {
    if (!scaleMask[j]) { mu[j] = 0; sd[j] = 1; continue; }
    const col = X.map((r) => r[j]);
    mu[j] = mean(col);
    sd[j] = Math.sqrt(mean(col.map((v) => (v - mu[j]) ** 2))) || 1;
  }
  return (row) => row.map((v, j) => (v - mu[j]) / sd[j]);
}

// ---- gradient boosted trees (histogram, least squares or Huber) ----------
// opts: { nTrees, lr, depth, minLeaf, bins, subsample, colsample, seed,
//         monotone: array of -1/0/+1 per feature, loss: 'ls'|'huber', huberDelta,
//         l2 (leaf L2 regularization) }

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function binEdges(col, nb) {
  const s = [...col].filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
  const edges = [];
  for (let i = 1; i < nb; i++) {
    const v = s[Math.floor((i * s.length) / nb)];
    if (v !== undefined && (edges.length === 0 || v > edges[edges.length - 1])) edges.push(v);
  }
  return edges; // value v goes to bin = #edges <= v ... use upper-bound search
}
function toBin(v, edges) {
  let lo = 0, hi = edges.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (v < edges[m]) hi = m; else lo = m + 1; }
  return lo;
}

function gbmFit(X, y, opts = {}) {
  const o = { nTrees: 400, lr: 0.05, depth: 4, minLeaf: 8, bins: 64, subsample: 0.8, colsample: 1, seed: 1, loss: 'ls', huberDelta: 0.1, l2: 1, ...opts };
  const n = X.length;
  const p = X[0].length;
  const mono = o.monotone || new Array(p).fill(0);
  const edges = [];
  const B = Array.from({ length: p }, () => new Uint8Array(n));
  for (let j = 0; j < p; j++) {
    edges[j] = binEdges(X.map((r) => r[j]), o.bins);
    for (let i = 0; i < n; i++) B[j][i] = toBin(X[i][j], edges[j]);
  }
  const nb = edges.map((e) => e.length + 1);
  // o.init: per-row starting log prediction (boost on top of another model)
  const base = o.init ? 0 : o.loss === 'huber' ? median(y) : mean(y);
  const F = o.init ? Float64Array.from(o.init) : new Float64Array(n).fill(base);
  const trees = [];
  const r = rng(o.seed);
  const grad = new Float64Array(n);

  for (let t = 0; t < o.nTrees; t++) {
    for (let i = 0; i < n; i++) {
      const res = y[i] - F[i];
      grad[i] = o.loss === 'huber' ? Math.max(-o.huberDelta, Math.min(o.huberDelta, res)) : res;
    }
    const idx = [];
    for (let i = 0; i < n; i++) if (r() < o.subsample) idx.push(i);
    const feats = [];
    for (let j = 0; j < p; j++) if (o.colsample >= 1 || r() < o.colsample) feats.push(j);
    if (!feats.length) feats.push(Math.floor(r() * p));

    const nodes = [];
    const build = (rows, d, lo, hi) => {
      let sg = 0;
      for (const i of rows) sg += grad[i];
      let val = sg / (rows.length + o.l2);
      val = Math.max(lo, Math.min(hi, val));
      const id = nodes.length;
      nodes.push({ leaf: true, val });
      if (d >= o.depth || rows.length < 2 * o.minLeaf) return id;
      let best = null;
      for (const j of feats) {
        const k = nb[j];
        const gs = new Float64Array(k), cs = new Float64Array(k);
        const bj = B[j];
        for (const i of rows) { gs[bj[i]] += grad[i]; cs[bj[i]]++; }
        let gl = 0, cl = 0;
        for (let b = 0; b < k - 1; b++) {
          gl += gs[b]; cl += cs[b];
          const cr = rows.length - cl;
          if (cl < o.minLeaf || cr < o.minLeaf) continue;
          const gr = sg - gl;
          const vl = gl / (cl + o.l2), vr = gr / (cr + o.l2);
          if (mono[j] > 0 && vl > vr) continue;
          if (mono[j] < 0 && vl < vr) continue;
          const gain = (gl * gl) / (cl + o.l2) + (gr * gr) / (cr + o.l2) - (sg * sg) / (rows.length + o.l2);
          if (!best || gain > best.gain) best = { gain, j, b, vl, vr };
        }
      }
      if (!best || best.gain <= 1e-12) return id;
      const L = [], R = [];
      for (const i of rows) (B[best.j][i] <= best.b ? L : R).push(i);
      let lLo = lo, lHi = hi, rLo = lo, rHi = hi;
      if (mono[best.j] !== 0) {
        const mid = (best.vl + best.vr) / 2;
        if (mono[best.j] > 0) { lHi = Math.min(hi, mid); rLo = Math.max(lo, mid); }
        else { lLo = Math.max(lo, mid); rHi = Math.min(hi, mid); }
      }
      const node = nodes[id];
      node.leaf = false;
      node.j = best.j;
      node.thr = best.b; // bin index threshold: go left if bin <= thr
      node.l = build(L, d + 1, lLo, lHi);
      node.r = build(R, d + 1, rLo, rHi);
      return id;
    };
    build(idx, 0, -Infinity, Infinity);
    // leaf values for Huber: the gradient mean is already the clipped residual mean
    const predNode = (bins) => {
      let k = 0;
      while (!nodes[k].leaf) k = bins(nodes[k].j) <= nodes[k].thr ? nodes[k].l : nodes[k].r;
      return nodes[k].val;
    };
    for (let i = 0; i < n; i++) F[i] += o.lr * predNode((j) => B[j][i]);
    trees.push(nodes);
  }
  const model = { base, trees, edges, lr: o.lr };
  model.predict = (x) => {
    const bins = x.map((v, j) => toBin(v, edges[j]));
    let s = base;
    for (const nodes of trees) {
      let k = 0;
      while (!nodes[k].leaf) k = bins[nodes[k].j] <= nodes[k].thr ? nodes[k].l : nodes[k].r;
      s += lr(nodes[k].val);
    }
    return s;
    function lr(v) { return o.lr * v; }
  };
  model.trainPred = F;
  return model;
}

module.exports = { dot, median, mean, solve, ridge, makeScaler, gbmFit, rng };
