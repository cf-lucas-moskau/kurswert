// Builds CSVs from data/raw_ads.json (produced by scrape.js).
// Re-run any time to change columns or filters without re-scraping.
//
// Usage:
//   node src/build_csv.js                # -> data/listings.csv (all countries)
//   node src/build_csv.js --de           # -> data/listings_de.csv (Germany only)
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ads = JSON.parse(fs.readFileSync(path.join(DATA, 'raw_ads.json'), 'utf8'));
const deOnly = process.argv.includes('--de');
const out = path.join(DATA, deOnly ? 'listings_de.csv' : 'listings.csv');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const parseKm = (s) => ((s || '').replace(/\./g, '').match(/(\d+)\s*km/) || [])[1] || '';
const parsePower = (s) => (s || '').match(/(\d+)\s*kW\s*\((\d+)\s*PS\)/)?.slice(1, 3) || ['', ''];

const header = [
  'id', 'url', 'make', 'model', 'title', 'variant', 'price_eur', 'price_rating',
  'first_registration', 'mileage_km', 'power_kw', 'power_ps', 'fuel', 'transmission',
  'battery_kwh', 'category', 'color', 'doors', 'seats', 'condition', 'zip', 'city',
  'country', 'seller_type', 'seller_name', 'seller_phone', 'seller_rating',
  'num_images', 'has_finance_offer',
];
const rows = [header.join(',')];
const filtered = ads
  .filter((ad) => !deOnly || ad.attr?.cn === 'DE')
  .sort((a, b) => (a.price?.grossAmount ?? 0) - (b.price?.grossAmount ?? 0));
for (const ad of filtered) {
  const a = ad.attr || {};
  const [kw, ps] = parsePower(a.pw);
  const ci = ad.contactInfo || {};
  rows.push([
    ad.id,
    `https://suchen.mobile.de/fahrzeuge/details.html?id=${ad.id}`,
    ad.make,
    ad.model,
    ad.shortTitle,
    ad.subTitle,
    ad.price?.grossAmount ?? '',
    ad.priceRating?.ratingLabel ?? '',
    a.fr ?? '',
    parseKm(a.ml),
    kw,
    ps,
    a.ft ?? '',
    a.tr ?? '',
    (a.bc || '').replace(/\s*kWh/, ''),
    ad.category ?? '',
    a.ecol ?? '',
    a.door ?? '',
    a.sc ?? '',
    a.gi ?? '',
    a.z ?? '',
    a.loc ?? '',
    a.cn ?? '',
    ci.sellerType ?? '',
    ci.name ?? '',
    ci.contactPhone ?? '',
    ci.rating?.score ?? '',
    ad.numImages ?? '',
    (ad.financePlans || []).length > 0,
  ].map(csvEscape).join(','));
}
fs.writeFileSync(out, rows.join('\n') + '\n');
console.log(`${filtered.length} rows -> ${out}`);
