// Builds a wide CSV from data/raw_details.json (produced by fetch_details.js).
// Spec attributes become one column per attribute tag (union across all ads),
// the equipment list becomes a |-separated `features` column, the seller
// description is stripped to plain text.
//
// Usage: node src/build_details_csv.js   # -> data/details.csv
const fs = require('fs');
const path = require('path');

const { DATA } = require('./paths');
const details = JSON.parse(fs.readFileSync(path.join(DATA, 'raw_details.json'), 'utf8'));
const out = path.join(DATA, 'details.csv');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const stripHtml = (h) => (h || '')
  .replace(/<br\s*\/?>|<\/li>|<\/p>|<hr\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/\n{2,}/g, '\n').trim();

const ads = Object.entries(details).filter(([, ad]) => !ad.gone);
console.log(`${ads.length} detail records (${Object.entries(details).length - ads.length} gone)`);

// union of attribute tags, in first-seen order
const tags = [];
for (const [, ad] of ads) {
  for (const attr of ad.attributes || []) {
    if (!tags.includes(attr.tag)) tags.push(attr.tag);
  }
}

const header = [
  'id', 'url', 'make', 'model', 'title', 'variant', 'price_eur', 'price_rating',
  ...tags.map((t) => t.replace(/[^a-zA-Z0-9]+/g, '_')),
  'features', 'description', 'num_images',
  'seller_type', 'seller_name', 'seller_address', 'seller_lat', 'seller_long',
  'seller_phone', 'seller_rating', 'seller_homepage',
];
const rows = [header.join(',')];
for (const [id, ad] of ads) {
  const attrMap = {};
  for (const attr of ad.attributes || []) attrMap[attr.tag] = attr.value;
  const ci = ad.contactInfo || {};
  const lat = ci.latLong?.lat ?? '';
  const long = ci.latLong?.lon ?? '';
  rows.push([
    id,
    `https://suchen.mobile.de/fahrzeuge/details.html?id=${id}`,
    ad.make ?? ad.makeKey,
    ad.model ?? ad.modelKey,
    ad.shortTitle,
    ad.subTitle,
    ad.price?.grossAmount ?? '',
    ad.priceRating?.ratingLabel ?? '',
    ...tags.map((t) => attrMap[t] ?? ''),
    (ad.features || []).join('|'),
    stripHtml(ad.htmlDescription),
    (ad.galleryImages || []).length,
    ci.sellerType ?? '',
    ci.name ?? '',
    [ci.address1, ci.address2].filter(Boolean).join(', '),
    lat,
    long,
    ci.phones?.[0]?.number ?? '',
    ci.rating?.score ?? '',
    ci.dealerHomepageLink ?? '',
  ].map(csvEscape).join(','));
}
fs.writeFileSync(out, rows.join('\n') + '\n');
console.log(`${ads.length} rows, ${header.length} columns -> ${out}`);
