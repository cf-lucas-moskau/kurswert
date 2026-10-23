// Trains the market-price model from the current listings and writes:
//   model.json        - the trained model (coefficients etc.), for reuse
//   valuations.json   - every listing with its market valuation, for the UI
// both in the data dir (src/paths.js)
//
// Re-run after any fresh scrape to re-price everything against the new market:
//   node pricing/train.js
const fs = require('fs');
const path = require('path');
const { train, predict, valuate } = require('./engine');
const { featurize } = require('./features');
const firstSeen = require('./first_seen');
const priceHistory = require('./price_history');
const { loadAds, makeTrainingFilter } = require('./load_ads');
const { DATA, dataFile } = require('../src/paths');
const { needsLabel } = require('./labels');

// mobile.de + AutoScout24 (cross-posted cars counted once)
const { ads, crossPosts } = loadAds();
console.log(`${ads.length} listings (${ads.filter((a) => a.source === 'autoscout24').length} from AutoScout24, ${crossPosts} cross-posts dropped)`);
const { map: seenMap } = firstSeen.stamp(ads.map((a) => a.id));
// record today's asking prices; a later cut shows up as a motivated-seller signal
priceHistory.observe(ads);
const TODAY = new Date();
const daysSince = (day) => (day ? Math.max(0, Math.round((TODAY - new Date(day)) / 86400000)) : null);

// AI labels (labels.json) correct the trim and flag damage/defects.
const labelsPath = dataFile('labels.json');
const labels = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, 'utf8')) : {};
// a mobile.de car whose detail page or label is still outstanding is unvetted:
// shown, but never a deal (AutoScout24 has no detail pages, so never pending)
const detailsPath = dataFile('raw_details.json');
const details = fs.existsSync(detailsPath) ? JSON.parse(fs.readFileSync(detailsPath, 'utf8')) : {};
const isPendingLabel = (a) => a.source !== 'autoscout24' && (!details[a.id] || needsLabel(a, details, labels));
// a car is a clean comparable for training only if unlabeled or labeled clean
// with a healthy battery; damaged/defective/salvage cars would bias the market down
const isCleanComp = (id) => {
  const l = labels[id];
  return !l || (l.condition === 'clean' && !l.batteryIssue);
};

// The market model represents German resale value (what a German dealer can
// sell for), so it is trained on German listings only. Every car — including
// cheaper foreign listings — is then valued against this German benchmark, so
// import opportunities surface correctly as deals.
const all = ads.map((a) => featurize(a, undefined, labels[a.id])).filter(Boolean).filter((r) => r.price > 0);
// train on German listings that are clean comparables (exclude damaged/defective)
const isTrainingRow = makeTrainingFilter(ads, labels);
const trainRows = all.filter(isTrainingRow);
const excluded = all.filter((r) => r.country === 'DE' && !isCleanComp(r.id)).length;
const model = train(trainRows);
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(dataFile('model.json'), JSON.stringify(model));
console.log(`trained German market model on ${trainRows.length} clean DE listings (excluded ${excluded} damaged/flagged) -> model.json`);

// Build the per-listing valuation feed the UI consumes. Market price is fixed
// here; the UI applies the dealer's margin live (maxBuyPrice = market/(1+margin)).
const out = [];
for (const a of ads) {
  const label = labels[a.id];
  const f = featurize(a, model.referenceDate, label);
  if (!f) continue;
  const v = predict(model, f);
  const val = valuate(model, a);
  const asking = a.price.grossAmount;
  // a flagged car (accident, defect, salvage) is not a clean deal even if cheap
  const flagged = !!(label && (label.condition !== 'clean' || label.batteryIssue));
  out.push({
    id: a.id,
    url: a.url || `https://suchen.mobile.de/fahrzeuge/details.html?id=${a.id}`,
    source: a.source || 'mobile.de',
    model: a.model,
    title: a.shortTitle,
    variant: a.subTitle,
    trim: f.trimLabel,
    condition: label?.condition || null,
    caveats: label?.priceCaveats || [],
    flagged,
    labeled: !!label,
    pendingLabel: isPendingLabel(a),
    firstSeen: seenMap[a.id] || null,
    daysOnMarket: daysSince(seenMap[a.id]), // days since we first saw it (lower bound on listing age)
    priceDrop: priceHistory.dropInfo(a.id), // null unless the seller cut the price
    regionPct: v.regionPct || 0,
    year: f.regYear ? String(f.regYear) : null,
    corrections: f.corrections, // fields overridden by the seller's own title
    firstReg: a.attr?.fr || null,
    ageYears: Number(f.ageYears.toFixed(1)),
    mileageKm: f.mileageKm,
    powerKw: f.powerKw,
    color: a.attr?.ecol || null,
    country: a.attr?.cn || null,
    city: a.attr?.loc || null,
    zip: a.attr?.z || null, // DE zips drive the dashboard's radius filter
    sellerType: a.contactInfo?.sellerType || null,
    isImport: f.country && f.country !== 'DE',
    image: a.previewImage?.src || a.previewThumbnails?.[0]?.src || null,
    ratingMobileDe: a.priceRating?.ratingLabel || null,
    asking,
    marketPrice: v.marketPrice,
    low: v.low,
    high: v.high,
    confidence: val.confidence,
    tier: v.tier,
    extrapolated: v.extrapolated,
    deltaPct: Number((((asking - v.marketPrice) / v.marketPrice) * 100).toFixed(1)),
    implausiblePrice: val.implausiblePrice || false,
  });
}
// default sort: biggest discount vs market first (best buying opportunities)
out.sort((a, b) => a.deltaPct - b.deltaPct);

// Calibration: derive the dealer's real margin from an actual offer they made.
// Their implied margin (market vs what they paid) becomes the default in the UI,
// so buy targets reflect how this dealer actually values cars.
let calibration = null;
const calibPath = path.join(__dirname, 'calibration.json');
if (fs.existsSync(calibPath)) {
  const c = JSON.parse(fs.readFileSync(calibPath, 'utf8'));
  const car = ads.find((a) => String(a.id) === String(c.benchmarkId));
  if (car) {
    const v = valuate(model, car);
    const impliedMarginPct = Math.round(((v.marketPrice - c.dealerOffer) / c.dealerOffer) * 100);
    calibration = {
      offer: c.dealerOffer,
      impliedMarginPct,
      offerPctOfMarket: Math.round((c.dealerOffer / v.marketPrice) * 100),
      car: {
        id: car.id,
        url: `https://suchen.mobile.de/fahrzeuge/details.html?id=${car.id}`,
        title: car.shortTitle,
        variant: car.subTitle,
        trim: featurize(car, model.referenceDate)?.trimLabel,
        year: (car.attr?.fr || '').slice(-4),
        mileageKm: v && featurize(car)?.mileageKm,
        asking: v.asking,
        marketPrice: v.marketPrice,
        low: v.low,
        high: v.high,
        image: car.previewImage?.src || car.previewThumbnails?.[0]?.src || null,
      },
    };
    console.log(`calibration: dealer offered ${c.dealerOffer} vs market ${v.marketPrice} -> implied margin ${impliedMarginPct}% (UI default)`);
  }
}

fs.writeFileSync(
  dataFile('valuations.json'),
  JSON.stringify({ generatedFrom: trainRows.length, referenceDate: model.referenceDate, calibration, listings: out })
);
console.log(`wrote ${out.length} valuations -> valuations.json`);

// Rebuild the New-arrivals feed (newest.json) from the fully-labeled
// valuations, in the listing-recency order value_newest recorded. This is what
// makes the "Neue Angebote" tab show corrected trims and damage/defect flags
// instead of the provisional, label-free version value_newest wrote at fetch time.
const newestIdsPath = dataFile('newest_ids.json');
if (fs.existsSync(newestIdsPath)) {
  const { fetchedAt, ids } = JSON.parse(fs.readFileSync(newestIdsPath, 'utf8'));
  const byId = Object.fromEntries(out.map((l) => [String(l.id), l]));
  const newestListings = ids.map((id) => byId[String(id)]).filter(Boolean);
  fs.writeFileSync(
    dataFile('newest.json'),
    JSON.stringify({ fetchedAt, listings: newestListings })
  );
  console.log(`rebuilt newest.json: ${newestListings.length} fresh arrivals, now with labels/flags`);
}
