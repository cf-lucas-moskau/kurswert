// The dealer's inbound pipeline: fetch the freshest listings that just came
// onto the market, value each against the trained German market model, and
// (crucially) MERGE the new ones into data/raw_ads.json so they flow through
// the same details -> label -> train vetting as every other car.
//
//   node pricing/value_newest.js         # newest ~60 listings (3 pages)
//   PAGES=5 MAKE_ID=135 node pricing/value_newest.js
//
// STANDING WORKFLOW (always run all four, in order — see CLAUDE.md):
//   node pricing/value_newest.js   # fetch freshest + merge into the dataset
//   node src/fetch_details.js      # detail pages for the newly-merged ids
//   node pricing/label.js          # AI trim/damage labels for the new ids
//   node pricing/train.js          # retrain + rebuild newest.json WITH labels
//
// value_newest writes a provisional newest.json immediately (no labels yet);
// train.js overwrites it with the fully-vetted version once labels exist.
// Requires a trained model (model.json in the data dir).
const fs = require('fs');
const { launchBrowser, closeBrowser, getPageState, sleep, jitter } = require('../src/browser');
const { extractSrp } = require('../src/srp');
const { valuate } = require('./engine');
const { featurize } = require('./features');
const { classifyListing } = require('./trim');
const firstSeen = require('./first_seen');
const priceHistory = require('./price_history');
const { dataFile } = require('../src/paths');

const MAKE_ID = process.env.MAKE_ID || '135';
const PAGES = parseInt(process.env.PAGES || '3', 10);
const model = JSON.parse(fs.readFileSync(dataFile('model.json'), 'utf8'));

function newestUrl(page) {
  const p = new URLSearchParams({
    dam: 'false', isSearchRequest: 'true', ms: `${MAKE_ID};;;`,
    ref: 'srp', sb: 'doc', od: 'down', vc: 'Car', // sb=doc&od=down = most recently listed first
  });
  if (page > 1) p.set('pageNumber', String(page));
  return `https://suchen.mobile.de/fahrzeuge/search.html?${p.toString()}`;
}

(async () => {
  await launchBrowser();
  const seen = new Set();
  const rawItems = []; // full ad objects, to merge into the market dataset
  const out = [];
  let rank = 0; // position in the newest-first (sb=doc) ordering = listing recency
  try {
    for (let pg = 1; pg <= PAGES; pg++) {
      if (pg > 1) await sleep(jitter());
      const { items } = (await getPageState(newestUrl(pg), extractSrp)).searchResults;
      for (const ad of items) {
        if (!ad.id || seen.has(ad.id)) continue;
        seen.add(ad.id);
        const v = valuate(model, ad, 0.15);
        if (!v.valuable) continue;
        rawItems.push(ad);
        const f = featurize(ad, model.referenceDate);
        out.push({
          id: ad.id,
          url: `https://suchen.mobile.de/fahrzeuge/details.html?id=${ad.id}`,
          model: ad.model,
          title: ad.shortTitle,
          variant: ad.subTitle,
          trim: f?.trimLabel || null,
          trimClass: classifyListing(ad),
          listedRank: rank++, // 0 = most recently listed on mobile.de
          year: (ad.attr?.fr || '').slice(-4) || null,
          ...listingFields(ad),
          ...v,
        });
      }
      console.log(`page ${pg}: ${out.length} valued so far`);
    }
    // record first-seen dates; mark which are brand-new to us this run
    const { map: seenMap, isNew } = firstSeen.stamp(out.map((l) => l.id));
    const today = new Date().toISOString().slice(0, 10);
    out.forEach((l) => {
      l.firstSeen = seenMap[l.id] || today;
      l.isNewToday = isNew.has(l.id);
    });
    out.sort((a, b) => a.listedRank - b.listedRank); // freshest listings first

    // Merge the fresh listings into the market dataset so details/label/train
    // reach them. Same object shape as the full scrape's search-result items.
    const RAW = dataFile('raw_ads.json');
    const existing = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf8')) : [];
    const indexById = new Map(existing.map((a, i) => [a.id, i]));
    let addedRaw = 0;
    let updated = 0;
    for (const ad of rawItems) {
      const i = indexById.get(ad.id);
      if (i == null) { existing.push(ad); indexById.set(ad.id, existing.length - 1); addedRaw++; }
      else { existing[i] = ad; updated++; } // refresh a re-seen ad (price may have changed)
    }
    fs.writeFileSync(RAW, JSON.stringify(existing));
    // fresh prices straight from mobile.de — a re-seen car with a new price
    // becomes a price-drop signal. Observed only after raw_ads was written, so
    // a crash in the merge can't leave history ahead of the dataset.
    priceHistory.observe(rawItems);
    out.forEach((l) => { l.priceDrop = priceHistory.dropInfo(l.id); });
    fs.writeFileSync(dataFile('newest.json'), JSON.stringify({ fetchedAt: today, listings: out }));
    console.log(`wrote ${out.length} freshly-listed + valued cars (${isNew.size} new to us) -> newest.json`);
    // record the fresh-listing order so train.js can rebuild newest.json (with
    // labels) in true listing-recency order
    fs.writeFileSync(dataFile('newest_ids.json'),
      JSON.stringify({ fetchedAt: today, ids: out.map((l) => l.id) }));
    console.log(`merged ${addedRaw} new + refreshed ${updated} known listings in data/raw_ads.json (${existing.length} total)`);
    console.log('next: npm run details && npm run label && npm run train  (fully vets the new arrivals)');
  } finally {
    await closeBrowser();
  }
})();

function listingFields(ad) {
  return {
    mileageKm: parseInt((ad.attr?.ml || '').replace(/[.\s]/g, ''), 10) || null,
    powerKw: parseInt((ad.attr?.pw || '').match(/(\d+)\s*kW/)?.[1] || '', 10) || null,
    country: ad.attr?.cn || null,
    isImport: (ad.attr?.cn || 'DE') !== 'DE',
    city: ad.attr?.loc || null,
    sellerType: ad.contactInfo?.sellerType || null,
    image: ad.previewImage?.src || ad.previewThumbnails?.[0]?.src || null,
    ratingMobileDe: ad.priceRating?.ratingLabel || null,
  };
}
