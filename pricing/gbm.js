// Gradient-boosted regression trees, dependency-free.
//
// Histogram-based (features are pre-binned into quantile bins), Huber loss so a
// few absurd listings can't dominate, and optional monotone constraints so the
// trees can never say "more km = more expensive". The fitted model is plain
// JSON (bin edges + node arrays) so it can live inside model.json.
//
// opts: { nTrees, lr, depth, minLeaf, bins, subsample, seed, huberDelta, l2,
//         monotone: array of -1 / 0 / +1 per feature }

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
  const s = [...col].sort((a, b) => a - b);
  const edges = [];
  for (let i = 1; i < nb; i++) {
    const v = s[Math.floor((i * s.length) / nb)];
    if (v !== undefined && (edges.length === 0 || v > edges[edges.length - 1])) edges.push(v);
  }
  return edges;
}

function toBin(v, edges) {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (v < edges[m]) hi = m;
    else lo = m + 1;
  }
  return lo;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function gbmFit(X, y, opts = {}) {
  const o = { nTrees: 400, lr: 0.05, depth: 4, minLeaf: 8, bins: 64, subsample: 0.8, seed: 1, huberDelta: 0.08, l2: 1, ...opts };
  const n = X.length;
  const p = X[0].length;
  const mono = o.monotone || new Array(p).fill(0);
  const edges = [];
  const B = [];
  for (let j = 0; j < p; j++) {
    edges[j] = binEdges(X.map((r) => r[j]), o.bins);
    B[j] = Uint8Array.from(X, (r) => toBin(r[j], edges[j]));
  }
  const nb = edges.map((e) => e.length + 1);
  const base = median(y);
  const F = new Float64Array(n).fill(base);
  const grad = new Float64Array(n);
  const rand = rng(o.seed);
  const trees = [];

  for (let t = 0; t < o.nTrees; t++) {
    for (let i = 0; i < n; i++) grad[i] = Math.max(-o.huberDelta, Math.min(o.huberDelta, y[i] - F[i]));
    const sample = [];
    for (let i = 0; i < n; i++) if (rand() < o.subsample) sample.push(i);

    // node = [feature, binThreshold, leftIdx, rightIdx] or [leafValue]
    const nodes = [];
    const build = (rows, depth, lo, hi) => {
      let sg = 0;
      for (const i of rows) sg += grad[i];
      const id = nodes.length;
      nodes.push([Math.max(lo, Math.min(hi, sg / (rows.length + o.l2)))]);
      if (depth >= o.depth || rows.length < 2 * o.minLeaf) return id;
      let best = null;
      for (let j = 0; j < p; j++) {
        const gs = new Float64Array(nb[j]);
        const cs = new Float64Array(nb[j]);
        for (const i of rows) { gs[B[j][i]] += grad[i]; cs[B[j][i]]++; }
        let gl = 0;
        let cl = 0;
        for (let b = 0; b < nb[j] - 1; b++) {
          gl += gs[b];
          cl += cs[b];
          const cr = rows.length - cl;
          if (cl < o.minLeaf || cr < o.minLeaf) continue;
          const gr = sg - gl;
          const vl = gl / (cl + o.l2);
          const vr = gr / (cr + o.l2);
          if ((mono[j] > 0 && vl > vr) || (mono[j] < 0 && vl < vr)) continue;
          const gain = (gl * gl) / (cl + o.l2) + (gr * gr) / (cr + o.l2) - (sg * sg) / (rows.length + o.l2);
          if (!best || gain > best.gain) best = { gain, j, b, vl, vr };
        }
      }
      if (!best || best.gain <= 1e-12) return id;
      const L = [];
      const R = [];
      for (const i of rows) (B[best.j][i] <= best.b ? L : R).push(i);
      // monotone: children are bounded by the midpoint so deeper splits can't
      // undo the ordering
      let [lLo, lHi, rLo, rHi] = [lo, hi, lo, hi];
      const mid = (best.vl + best.vr) / 2;
      if (mono[best.j] > 0) { lHi = Math.min(hi, mid); rLo = Math.max(lo, mid); }
      if (mono[best.j] < 0) { lLo = Math.max(lo, mid); rHi = Math.min(hi, mid); }
      const l = build(L, depth + 1, lLo, lHi);
      const r = build(R, depth + 1, rLo, rHi);
      nodes[id] = [best.j, best.b, l, r];
      return id;
    };
    build(sample, 0, -Infinity, Infinity);
    for (let i = 0; i < n; i++) F[i] += o.lr * leafOf(nodes, (j) => B[j][i]);
    trees.push(nodes);
  }
  return { model: { base, lr: o.lr, edges, trees }, trainPred: Array.from(F) };
}

function leafOf(nodes, binOf) {
  let k = 0;
  while (nodes[k].length > 1) k = binOf(nodes[k][0]) <= nodes[k][1] ? nodes[k][2] : nodes[k][3];
  return nodes[k][0];
}

function gbmPredict(model, x) {
  const bins = x.map((v, j) => toBin(v, model.edges[j]));
  let s = model.base;
  for (const nodes of model.trees) s += model.lr * leafOf(nodes, (j) => bins[j]);
  return s;
}

module.exports = { gbmFit, gbmPredict };
