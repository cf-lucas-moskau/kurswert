// Loads every scraped listing: mobile.de (data/raw_ads.json) plus AutoScout24
// (data/raw_ads_as24.json, if scraped), with cross-posts removed.
//
// Dealers commonly list the same car on both marketplaces. Counting it twice
// would overweight it in the fit and leak between CV folds, so an AutoScout24
// ad that matches a mobile.de ad on model, first registration, mileage (±1%)
// and price (±3%) is dropped in favour of the mobile.de one.
const fs = require('fs');
const path = require('path');
const { parseKm } = require('./features');

const DATA = path.join(__dirname, '..', 'data');

function sameCar(a, b) {
  if (a.model !== b.model || a.attr?.fr !== b.attr?.fr) return false;
  const kmA = parseKm(a.attr?.ml), kmB = parseKm(b.attr?.ml);
  const pA = a.price?.grossAmount, pB = b.price?.grossAmount;
  if (kmA == null || kmB == null || !pA || !pB) return false;
  return Math.abs(kmA - kmB) <= Math.max(500, 0.01 * kmA) && Math.abs(pA - pB) / pA <= 0.03;
}

// Within one marketplace, dealer groups post the same car at every branch
// (one Spanish chain lists each car up to 12 times with only the city
// changed). Identical model + first registration + mileage + price means the
// same car; keep the first listing and count the rest as `repeats`.
function dedupeRepeats(ads) {
  const seen = new Map();
  const out = [];
  for (const a of ads) {
    const km = parseKm(a.attr?.ml);
    const price = a.price?.grossAmount;
    if (km == null || !price) { out.push(a); continue; }
    const key = `${a.source || 'mobile.de'}|${a.model}|${a.attr?.fr}|${km}|${price}`;
    const first = seen.get(key);
    if (first) { first.repeats = (first.repeats || 0) + 1; continue; }
    const copy = { ...a };
    seen.set(key, copy);
    out.push(copy);
  }
  return out;
}

function loadAds({ includeAs24 = true } = {}) {
  const mobile = dedupeRepeats(JSON.parse(fs.readFileSync(path.join(DATA, 'raw_ads.json'), 'utf8')));
  const as24Path = path.join(DATA, 'raw_ads_as24.json');
  if (!includeAs24 || !fs.existsSync(as24Path)) return { ads: mobile, crossPosts: 0 };
  const as24 = dedupeRepeats(JSON.parse(fs.readFileSync(as24Path, 'utf8')));
  // bucket mobile ads by model + first registration so matching stays cheap
  const bucket = {};
  for (const a of mobile) (bucket[`${a.model}|${a.attr?.fr}`] ||= []).push(a);
  const unique = as24.filter((a) => !(bucket[`${a.model}|${a.attr?.fr}`] || []).some((m) => sameCar(a, m)));
  return { ads: [...mobile, ...unique], crossPosts: as24.length - unique.length };
}

// Which listings train the German market model. Shared by train.js and
// evaluate.js so the reported accuracy is for the model that actually ships.
//  - German mobile.de listings only: AutoScout24 states power on a different
//    basis (median Model Y 258 vs 313 kW for the same cars) and adding its ads
//    did not improve held-out accuracy (pricing/lab/REPORT.md)
//  - not labeled damaged / battery issue
//  - a plausible price: one-off collector asks (a 499,000 EUR "Plaid Signature")
//    and typos (a 460,000 EUR Model 3) are not market evidence
const PRICE_MIN = 2000;
const PRICE_MAX = 200000;
function makeTrainingFilter(ads, labels) {
  const source = new Map(ads.map((a) => [a.id, a.source || 'mobile.de']));
  return (r) => {
    const l = labels[r.id];
    return r.country === 'DE' && source.get(r.id) === 'mobile.de' && r.price >= PRICE_MIN && r.price <= PRICE_MAX &&
      (!l || (l.condition === 'clean' && !l.batteryIssue));
  };
}

module.exports = { loadAds, sameCar, dedupeRepeats, makeTrainingFilter };
