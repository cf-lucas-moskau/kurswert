// Scrapes all Tesla listings from AutoScout24 (the second big EU marketplace)
// into data/raw_ads_as24.json, mapped to the mobile.de search-listing shape so
// features/train/labels work unchanged. Each ad gets source 'autoscout24' and an
// id prefixed "as24:" so it can never collide with a mobile.de id.
//
// Data source is __NEXT_DATA__ on the classic list page. AutoScout24 caps
// pagination at 200 pages, so the search is split into price segments that are
// halved until each fits. Progress is checkpointed after every page; kill and
// rerun to resume.
//
// Usage:
//   node src/scrape_autoscout.js
// Fresh run: delete data/raw_ads_as24.json and data/progress_as24.json first.
const fs = require('fs');
const path = require('path');
const { launchBrowser, closeBrowser, getPageState, sleep, jitter } = require('./browser');

const DATA = path.join(__dirname, '..', 'data');
const RAW = path.join(DATA, 'raw_ads_as24.json');
const PROGRESS = path.join(DATA, 'progress_as24.json');
const BASE = 'https://www.autoscout24.de/lst/tesla';
// same EU footprint mobile.de returns; Germany is what the model trains on
const COUNTRIES = 'D,A,B,E,F,I,L,NL';
const MAX_PAGES = 200;

fs.mkdirSync(DATA, { recursive: true });
const ads = new Map();
if (fs.existsSync(RAW)) {
  for (const ad of JSON.parse(fs.readFileSync(RAW, 'utf8'))) ads.set(ad.id, ad);
  console.log(`resumed with ${ads.size} ads`);
}
const progress = fs.existsSync(PROGRESS) ? JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) : {};

function saveState() {
  fs.writeFileSync(RAW, JSON.stringify([...ads.values()]));
  fs.writeFileSync(PROGRESS, JSON.stringify(progress, null, 1));
}

function searchUrl({ min, max, page }) {
  const params = new URLSearchParams({
    atype: 'C',
    cy: COUNTRIES,
    damaged_listing: 'exclude',
    desc: '0',
    sort: 'price', // stable order while paginating
    ustate: 'N,U',
    page: String(page || 1),
  });
  if (min != null) params.set('pricefrom', String(min));
  if (max != null) params.set('priceto', String(max));
  return `${BASE}?${params.toString()}`;
}

const extractList = () => {
  const el = document.getElementById('__NEXT_DATA__');
  if (!el) return null;
  try {
    const pp = JSON.parse(el.textContent).props.pageProps;
    if (!Array.isArray(pp.listings)) return null;
    return {
      listings: pp.listings,
      numberOfResults: pp.numberOfResults,
      numberOfPages: pp.numberOfPages,
      page: Number(pp.pageQuery?.page || 1),
    };
  } catch { return null; }
};

// AutoScout24 country codes on listings are ISO-2; normalize the odd ones
const COUNTRY = { D: 'DE', A: 'AT', B: 'BE', E: 'ES', F: 'FR', I: 'IT', L: 'LU' };

const modelFromText = (t) => {
  const m = (t || '').match(/model\s*([3sxy])\b/i);
  return m ? `Model ${m[1].toUpperCase()}` : 'Andere';
};

// Map one AutoScout24 listing to the mobile.de search-ad shape.
function toAd(l) {
  const details = {};
  for (const d of l.vehicleDetails || []) details[d.ariaLabel] = d.data;
  const v = l.vehicle || {};
  const cn = COUNTRY[l.location?.countryCode] || l.location?.countryCode || null;
  const variant = [v.modelVersionInput, v.variant, v.subtitle].filter(Boolean).join(' ');
  const img = (l.images || [])[0];
  const model = v.model === 'Sonstige' ? modelFromText(variant) : v.model;
  return {
    id: `as24:${l.id}`,
    source: 'autoscout24',
    url: `https://www.autoscout24.de${l.url}`,
    attr: {
      fr: details.Erstzulassung,
      ml: details.Kilometerstand || v.mileageInKm,
      pw: details.Leistung,
      cn,
      z: l.location?.zip || null,
      loc: l.location?.city || null,
    },
    make: v.make,
    // AutoScout24 files some Teslas under "Sonstige"; the variant text usually names the model
    model,
    shortTitle: `${v.make || 'Tesla'} ${model || ''}`.trim(),
    subTitle: variant,
    price: { grossAmount: l.price?.priceRaw ?? null },
    contactInfo: { country: cn, sellerType: l.seller?.type === 'Dealer' ? 'DEALER' : 'PRIVATE' },
    sellerId: l.seller?.id ? `as24:${l.seller.id}` : null,
    previewImage: img ? { src: img.replace(/\/\d+x\d+\.webp$/, '/480x360.webp') } : null,
  };
}

async function scrapeSegment(min, max) {
  const key = `${min}:${max}`;
  if (progress[key]?.done) {
    console.log(`segment ${key} already done, skipping`);
    return;
  }
  const first = await getPageState(searchUrl({ min, max, page: 1 }), extractList);
  console.log(`segment ${key} -> ${first.numberOfResults} results, ${first.numberOfPages} pages`);
  if (first.numberOfPages >= MAX_PAGES && max - min > 1) {
    const mid = Math.floor((min + max) / 2);
    await scrapeSegment(min, mid);
    await scrapeSegment(mid + 1, max);
    progress[key] = { done: true };
    saveState();
    return;
  }
  for (const l of first.listings) ads.set(`as24:${l.id}`, toAd(l));
  const startPage = Math.max(2, (progress[key]?.lastPage || 1) + 1);
  for (let p = startPage; p <= first.numberOfPages; p++) {
    await sleep(jitter());
    const next = await getPageState(searchUrl({ min, max, page: p }), extractList);
    if (next.page !== p) {
      console.log(`  ! asked page ${p}, got ${next.page} — stopping segment`);
      break;
    }
    const before = ads.size;
    for (const l of next.listings) ads.set(`as24:${l.id}`, toAd(l));
    progress[key] = { lastPage: p };
    saveState();
    console.log(`  page ${p}/${first.numberOfPages}: +${ads.size - before} (total unique ${ads.size})`);
  }
  progress[key] = { done: true };
  saveState();
}

(async () => {
  await launchBrowser({
    profilesDir: path.join(__dirname, '..', 'profiles-as24'),
    warmup: 'https://www.autoscout24.de/',
  });
  try {
    // fixed Tesla-shaped bands; oversized ones are halved recursively
    const cuts = [0, 20000, 28000, 36000, 50000, 10000000];
    for (let i = 0; i < cuts.length - 1; i++) await scrapeSegment(cuts[i] === 0 ? 0 : cuts[i] + 1, cuts[i + 1]);
    console.log(`\nDONE: ${ads.size} unique listings in data/raw_ads_as24.json`);
  } finally {
    saveState();
    await closeBrowser();
  }
})();
