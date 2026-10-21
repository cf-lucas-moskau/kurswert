// Frozen dataset + fixed splits for the pricing lab. Everything reads the
// snapshot in pricing/lab/snapshot/, never data/, so runs stay comparable.
const fs = require('fs');
const path = require('path');
const { featurize } = require('./baseline/features');

const SNAP = path.join(__dirname, 'snapshot');
const ads = JSON.parse(fs.readFileSync(path.join(SNAP, 'raw_ads.json'), 'utf8'));
const labels = JSON.parse(fs.readFileSync(path.join(SNAP, 'labels.json'), 'utf8'));

// same filter as train.js: German, unlabeled or labeled clean with healthy battery
const isCleanComp = (id) => {
  const l = labels[id];
  return !l || (l.condition === 'clean' && !l.batteryIssue);
};

// Near-duplicate key: the same physical car re-posted (same dealer twice, or two
// linked dealer accounts) shares model + first reg + exact km + power. Seller is
// deliberately NOT in the key: sellers 455119 and 45364575 post identical cars.
const groupKey = (ad) => [ad.model, ad.attr?.fr, ad.attr?.ml, ad.attr?.pw].join('|');

function record(ad) {
  const label = labels[ad.id] || null;
  const f = featurize(ad, undefined, label);
  if (!f || !(f.price > 0)) return null;
  return { id: ad.id, ad, label, f, price: f.price, model: f.model, group: groupKey(ad) };
}

const all = ads.map(record).filter(Boolean);
const universe = all.filter((r) => r.f.country === 'DE' && isCleanComp(r.id));
const universeIds = new Set(universe.map((r) => r.id));
// everything else (foreign, damaged) can be used as auxiliary training data by a
// candidate; it is never scored
const aux = all.filter((r) => !universeIds.has(r.id));

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, seed) {
  const a = [...arr];
  const r = rng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// group-level split: all listings of a near-duplicate group land on the same side
const groups = [...new Set(universe.map((r) => r.group))].sort();
const HOLDOUT_SEED = 20261021;
const HOLDOUT_FRAC = 0.15;
const shuffledGroups = shuffle(groups, HOLDOUT_SEED);
const holdoutGroups = new Set(shuffledGroups.slice(0, Math.round(groups.length * HOLDOUT_FRAC)));
const holdout = universe.filter((r) => holdoutGroups.has(r.group));
const dev = universe.filter((r) => !holdoutGroups.has(r.group));

// grouped K-fold over dev for one repeat
// CV_GROUP=seller groups by seller instead (stricter: a dealer's whole stock is
// held out together, so a dealer-specific markup can't be learned from siblings)
function folds(rows, k, seed) {
  const key = process.env.CV_GROUP === 'seller' ? (r) => `s${r.ad.sellerId}` : (r) => r.group;
  const gs = shuffle([...new Set(rows.map(key))].sort(), seed);
  const foldOf = new Map(gs.map((g, i) => [g, i % k]));
  const out = Array.from({ length: k }, () => []);
  for (const r of rows) out[foldOf.get(key(r))].push(r);
  return out;
}

// ---- AutoScout24 (optional second source) ----------------------------------
// Snapshot copy of data/raw_ads_as24.json. Cross-posts of any mobile.de ad
// (same model + first reg, km ±1%, price ±3%, as pricing/load_ads.js) are
// dropped up front; harness additionally drops, per fold, any AS24 ad that
// matches a TEST car on model + first reg + km ±1% regardless of price, so a
// re-priced cross-post cannot leak the test car's price into training.
const AS24_PATH = path.join(SNAP, 'raw_ads_as24.json');
const kmOf = (ad) => { const m = (ad.attr?.ml || '').replace(/[.\s]/g, '').match(/(\d+)/); return m ? +m[1] : null; };
const sameCarLoose = (a, b) => {
  if (a.model !== b.model || a.attr?.fr !== b.attr?.fr) return false;
  const ka = kmOf(a), kb = kmOf(b);
  return ka != null && kb != null && Math.abs(ka - kb) <= Math.max(500, 0.01 * ka);
};
let as24 = [];
let as24Stats = null;
if (fs.existsSync(AS24_PATH)) {
  const raw = JSON.parse(fs.readFileSync(AS24_PATH, 'utf8'));
  const bucket = {};
  for (const a of ads) (bucket[`${a.model}|${a.attr?.fr}`] ||= []).push(a);
  const crossPost = (a) => (bucket[`${a.model}|${a.attr?.fr}`] || []).some((m) =>
    sameCarLoose(a, m) && Math.abs(a.price.grossAmount - m.price.grossAmount) / m.price.grossAmount <= 0.03);
  const recs = raw.map(record).filter(Boolean);
  as24 = recs.filter((r) => !crossPost(r.ad));
  as24Stats = { raw: raw.length, usable: recs.length, crossPosts: recs.length - as24.length };
}
function as24For(testRows) {
  const bucket = {};
  for (const r of testRows) (bucket[`${r.ad.model}|${r.ad.attr?.fr}`] ||= []).push(r.ad);
  return as24.filter((r) => !(bucket[`${r.ad.model}|${r.ad.attr?.fr}`] || []).some((m) => sameCarLoose(r.ad, m)));
}

module.exports = { as24, as24Stats, as24For, sameCarLoose, ads, labels, all, universe, dev, holdout, aux, folds, groupKey, shuffle, rng };
