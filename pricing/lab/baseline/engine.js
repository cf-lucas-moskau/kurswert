// Market-price engine.
//
// Core idea: a used car's price is driven by model, age, mileage, power and
// trim. We fit a log-linear regression (log price is roughly linear in these
// drivers, and depreciation is multiplicative, so logs are the natural space).
//
// Two-tier model, so it degrades gracefully:
//   - per-model regression for models with enough listings (robust, captures
//     model-specific depreciation),
//   - a pooled global regression with model dummies as the fallback for sparse
//     models (Roadster etc.), so they still borrow the shared age/mileage slope.
//
// The whole model is derived from the current listing population, so re-running
// train.js after a fresh scrape re-prices everything against the new market.
//
// Everything here is dependency-free (own small linear-algebra) so it runs in
// plain Node and is trivial to test.

const { featurize, REFERENCE_DATE } = require('./features');

const MIN_SAMPLES_PER_MODEL = 40; // below this, fall back to the pooled global model
const RIDGE_LAMBDA = 1.0; // regularization on scaled predictors (not the intercept)
const OUTLIER_SIGMA = 2.5; // drop listings this far from the fit (in log space) then refit
const REGION_SHRINK_K = 15; // empirical-Bayes shrinkage: a zone's adjustment gets weight n/(n+K)

// ---- linear algebra -------------------------------------------------------

function solveLinearSystem(A, b) {
  // Gaussian elimination with partial pivoting. A is n×n (mutated), b is length n.
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) continue; // singular column; leave coef at 0
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(M[i][i]) < 1e-12 ? 0 : row[n] / M[i][i]));
}

// Ridge regression: solve (XᵀX + λD) β = Xᵀy, D = identity with 0 on the intercept.
function ridgeFit(X, y, lambda) {
  const n = X.length;
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    for (let a = 0; a < p; a++) {
      Xty[a] += xi[a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += xi[a] * xi[b];
    }
  }
  for (let a = 1; a < p; a++) XtX[a][a] += lambda; // skip intercept (column 0)
  return solveLinearSystem(XtX, Xty);
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// ---- feature vectors ------------------------------------------------------
// Continuous predictors are standardized (mean 0, sd 1) to keep the normal
// equations well-conditioned; binaries are left as 0/1.

function continuousRaw(f) {
  const km = f.mileageKm / 100000;
  // age² and mileage² capture the convex depreciation curve: value drops
  // steeply at first, and again very steeply at extreme mileage. Without the
  // squared mileage term the model over-values 200k+ km cars.
  return [f.ageYears, f.ageYears * f.ageYears, km, km * km, f.powerKw / 100];
}

function makeScaler(rows) {
  const raw = rows.map(continuousRaw);
  const k = raw[0].length;
  const mean = new Array(k).fill(0);
  const sd = new Array(k).fill(0);
  for (const r of raw) for (let i = 0; i < k; i++) mean[i] += r[i] / raw.length;
  for (const r of raw) for (let i = 0; i < k; i++) sd[i] += (r[i] - mean[i]) ** 2 / raw.length;
  for (let i = 0; i < k; i++) sd[i] = Math.sqrt(sd[i]) || 1;
  return { mean, sd };
}

function scaledContinuous(f, scaler) {
  return continuousRaw(f).map((v, i) => (v - scaler.mean[i]) / scaler.sd[i]);
}

// per-model design row: [1, age, age², mileage, mileage², power, awd, perf, plaid, longRange]
function rowFeatures(f, scaler) {
  return [1, ...scaledContinuous(f, scaler), f.awd, f.performance, f.plaid, f.longRange];
}

// global design row: [1, <model dummies>, ...continuous, awd, perf, plaid, longRange]
function globalRowFeatures(f, scaler, modelList) {
  const dummies = modelList.slice(1).map((m) => (f.model === m ? 1 : 0)); // first model is the base level
  return [1, ...dummies, ...scaledContinuous(f, scaler), f.awd, f.performance, f.plaid, f.longRange];
}

// ---- fitting --------------------------------------------------------------

// floor the age so near-new cars with delivery mileage don't divide by ~0
const kmPerYear = (f) => f.mileageKm / Math.max(f.ageYears, 0.5);

function fitBlock(rows, buildRow) {
  const y = rows.map((r) => Math.log(r.price));
  let X = rows.map(buildRow);
  let coef = ridgeFit(X, y, RIDGE_LAMBDA);

  // one robust refit: drop listings whose log-price is way off the first fit
  // (mispriced ads, data errors) so they don't drag the market estimate.
  let resid = y.map((yi, i) => yi - dot(X[i], coef));
  let sigma = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / resid.length);
  const keep = rows.filter((_, i) => Math.abs(resid[i]) <= OUTLIER_SIGMA * sigma);
  const kept = keep.length >= 10 && keep.length < rows.length ? keep : rows;
  const yk = kept.map((r) => Math.log(r.price));
  X = kept.map(buildRow);
  coef = ridgeFit(X, yk, RIDGE_LAMBDA);
  resid = yk.map((yi, i) => yi - dot(X[i], coef));
  sigma = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / resid.length);

  // Duan's smearing estimate: corrects the bias from exp() of a log-space fit.
  const smearing = resid.reduce((s, r) => s + Math.exp(r), 0) / resid.length;

  // training support: cars outside this age/mileage range are extrapolations,
  // where the fit is guessing rather than interpolating comparable listings.
  const pct = (vals, q) => {
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  };
  const ranges = {
    ageHi: pct(kept.map((r) => r.ageYears), 0.975),
    mileageHi: pct(kept.map((r) => r.mileageKm), 0.975),
    // age and mileage can each be in range while their combination is not
    // (173,000 km on a 2.6-year-old car); km per year catches that
    kmPerYearHi: pct(kept.map(kmPerYear), 0.975),
  };

  // R² in log space
  const meanY = yk.reduce((a, b) => a + b, 0) / yk.length;
  const ssTot = yk.reduce((s, yi) => s + (yi - meanY) ** 2, 0);
  const ssRes = resid.reduce((s, r) => s + r * r, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { coef, sigma, smearing, r2, n: kept.length, ranges };
}

// rows: featurized listings (each needs .price). Returns a serializable model.
function train(rows) {
  const usable = rows.filter((r) => r && r.price > 0);
  const byModel = {};
  for (const r of usable) (byModel[r.model] = byModel[r.model] || []).push(r);
  const modelList = Object.keys(byModel).sort((a, b) => byModel[b].length - byModel[a].length);

  // global pooled model (fallback)
  const globalScaler = makeScaler(usable);
  const global = {
    ...fitBlock(usable, (f) => globalRowFeatures(f, globalScaler, modelList)),
    scaler: globalScaler,
    modelList,
  };

  // per-model models where we have enough data
  const perModel = {};
  for (const [model, rowsM] of Object.entries(byModel)) {
    if (rowsM.length < MIN_SAMPLES_PER_MODEL) continue;
    const scaler = makeScaler(rowsM);
    perModel[model] = { ...fitBlock(rowsM, (f) => rowFeatures(f, scaler)), scaler };
  }

  const model = {
    referenceDate: REFERENCE_DATE,
    trainedOn: usable.length,
    minSamples: MIN_SAMPLES_PER_MODEL,
    perModel,
    global,
  };

  // Regional price adjustment: the same car sells for measurably more in some
  // PLZ zones (documented 10-20% metro/south premium). The base fit is blind to
  // location, so each zone's mean log-residual is its local premium/discount.
  // Shrunk toward 0 by sample size so thin zones don't get noisy adjustments.
  const byZone = {};
  for (const r of usable) {
    if (!r.plzZone) continue;
    const resid = Math.log(r.price) - baseLogPred(model, r);
    (byZone[r.plzZone] = byZone[r.plzZone] || []).push(resid);
  }
  const regionAdj = {};
  for (const [zone, rs] of Object.entries(byZone)) {
    // median, not mean: one absurdly mispriced listing must not shift its zone
    const s = [...rs].sort((a, b) => a - b);
    const med = s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    regionAdj[zone] = med * (rs.length / (rs.length + REGION_SHRINK_K));
  }
  model.regionAdj = regionAdj;
  return model;
}

// ---- prediction -----------------------------------------------------------

// Returns market valuation for one featurized car:
//   { marketPrice, low, high, tier, nComps, r2 }
// low/high are a ~68% band (±1 residual sigma in log space).
function baseLogPred(model, f) {
  const per = model.perModel[f.model];
  if (per) return dot(rowFeatures(f, per.scaler), per.coef);
  return dot(globalRowFeatures(f, model.global.scaler, model.global.modelList), model.global.coef);
}

function predict(model, f) {
  const per = model.perModel[f.model];
  const block = per || model.global;
  // location premium/discount learned from the training residuals per PLZ zone
  const regionAdj = (f.plzZone && model.regionAdj?.[f.plzZone]) || 0;
  const logPred = baseLogPred(model, f) + regionAdj;
  const marketPrice = Math.exp(logPred) * block.smearing;
  // widen the band and flag when the car sits beyond the training support
  const extrapolated = f.ageYears > block.ranges.ageHi || f.mileageKm > block.ranges.mileageHi ||
    (block.ranges.kmPerYearHi != null && kmPerYear(f) > block.ranges.kmPerYearHi);
  const sigma = extrapolated ? block.sigma * 1.8 : block.sigma;
  return {
    marketPrice: Math.round(marketPrice),
    low: Math.round(marketPrice * Math.exp(-sigma)),
    high: Math.round(marketPrice * Math.exp(sigma)),
    tier: per ? 'model' : 'global',
    nComps: block.n,
    r2: block.r2,
    extrapolated,
    // how much the PLZ-zone adjustment moved the estimate (e.g. +4 = 4% premium)
    regionPct: Math.round((Math.exp(regionAdj) - 1) * 100),
  };
}

// Full dealer valuation for a raw ad: market price vs asking, plus a buy target
// for a desired resale margin. marginPct is the markup on the purchase price the
// dealer wants to make when reselling at market (e.g. 0.15 = 15%).
// opts.holdingDays / opts.dailyCost model the cost of the car sitting on the
// lot before it resells (capital, space, care — the "Standtage" cost). It comes
// straight off the buy target: maxBuy = market/(1+margin) − holdingDays·dailyCost.
function valuate(model, ad, marginPct = 0.15, opts = {}) {
  const f = featurize(ad, model.referenceDate);
  if (!f) return { valuable: false, reason: 'missing age/mileage/power' };
  const v = predict(model, f);
  const asking = ad.price?.grossAmount ?? null;
  const holdingCost = Math.max(0, Math.round((opts.holdingDays || 0) * (opts.dailyCost || 0)));
  const maxBuyPrice = Math.max(0, Math.round(v.marketPrice / (1 + marginPct)) - holdingCost);
  const result = {
    valuable: true,
    marketPrice: v.marketPrice,
    low: v.low,
    high: v.high,
    tier: v.tier,
    nComps: v.nComps,
    r2: Number(v.r2.toFixed(3)),
    extrapolated: v.extrapolated,
    // how much to trust this valuation: high = dense same-model comps in range;
    // low = pooled fallback model or a car outside the training support
    confidence: v.extrapolated || v.tier === 'global' ? 'low' : v.nComps > 100 ? 'high' : 'medium',
    regionPct: v.regionPct,
    asking,
    holdingCost,
    maxBuyPrice, // pay at most this to still hit the margin when reselling at market
  };
  if (asking != null) {
    result.deltaAbs = asking - v.marketPrice; // negative = listed below market
    result.deltaPct = Number((((asking - v.marketPrice) / v.marketPrice) * 100).toFixed(1));
    // profit if bought at asking and resold at market
    result.marginAtAsking = Number((((v.marketPrice - asking) / asking) * 100).toFixed(1));
    // a genuine deal is below the buy target AND within the model's support;
    // an extrapolated "deal" is flagged separately so the dealer verifies it
    // contradictory listing data (title corrected a field) is uncertain too
    const shaky = v.extrapolated || f.corrections.length > 0;
    result.isDeal = asking <= maxBuyPrice && !shaky;
    result.uncertainDeal = asking <= maxBuyPrice && shaky;
  }
  return result;
}

module.exports = { train, predict, valuate, featurize };
