// Scrapes all search-result listings for one make from mobile.de.
//
// Data source is the __INITIAL_STATE__ JSON embedded in every classic
// search-results page — no HTML parsing. The search is split into price
// segments because mobile.de caps pagination at 50 pages; segments that are
// still too big get split recursively. Progress is checkpointed after every
// page, so the script can be killed and rerun and it resumes where it left off.
//
// Usage:
//   node src/scrape.js              # Tesla (make id 135)
//   MAKE_ID=3500 node src/scrape.js # BMW
// Fresh run: delete data/raw_ads.json and data/progress.json first.
const fs = require('fs');
const path = require('path');
const { launchBrowser, closeBrowser, getPageState, sleep, jitter } = require('./browser');

const MAKE_ID = process.env.MAKE_ID || '135'; // 135 = Tesla
const DATA = path.join(__dirname, '..', 'data');
const RAW = path.join(DATA, 'raw_ads.json');
const PROGRESS = path.join(DATA, 'progress.json');
const BASE = 'https://suchen.mobile.de/fahrzeuge/search.html';
const MAX_SAFE_RESULTS = 900; // 50-page cap x ~20 ads, with margin

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
    dam: 'false',
    isSearchRequest: 'true',
    ms: `${MAKE_ID};;;`,
    ref: 'srp',
    sb: 'p', // sort by price ascending: stable order while paginating
    od: 'up',
    vc: 'Car',
  });
  if (min != null || max != null) params.set('p', `${min ?? ''}:${max ?? ''}`);
  if (page && page > 1) params.set('pageNumber', String(page));
  return `${BASE}?${params.toString()}`;
}

// Runs in the page. Supports both the classic SRP (__INITIAL_STATE__) and the
// Next.js search experience mobile.de rolled out to everyone by Oct 2026, where
// listings live in the RSC flight payload (self.__next_f) and titles only in the
// rendered card props. New-experience listings are mapped to the classic shape
// so everything downstream (features, train, labels) keeps working unchanged.
const extractSrp = () => {
  const d = window.__INITIAL_STATE__?.search?.srp?.data;
  if (d?.searchResults) return { searchResults: d.searchResults, aggregations: d.aggregations };
  // read the flight chunks from the inline <script> tags, not the self.__next_f
  // array: once Next hydrates it swaps push() for a callback and later chunks
  // never land in the array, so the array is timing-dependent
  const PREFIX = 'self.__next_f.push(';
  const s = [...document.querySelectorAll('script:not([src])')]
    .map((el) => el.textContent)
    .filter((t) => t.startsWith(PREFIX))
    .map((t) => { try { const c = JSON.parse(t.slice(PREFIX.length, t.lastIndexOf(')'))); return typeof c[1] === 'string' ? c[1] : ''; } catch { return ''; } })
    .join('');
  const at = s.indexOf('{"numResultsTotal"');
  if (at < 0) return null;
  let depth = 0, end = at;
  for (; end < s.length; end++) {
    if (s[end] === '{') depth++;
    else if (s[end] === '}' && --depth === 0) break;
  }
  let data;
  try { data = JSON.parse(s.slice(at, end + 1)); } catch { return null; } // payload still streaming
  if (!Array.isArray(data.listings)) return null;
  // titles: each card's props carry listingId, followed by its shortTitle/subTitle
  const titles = {};
  const ids = [...s.matchAll(/"listingId":(\d+)/g)];
  ids.forEach((m, i) => {
    const chunk = s.slice(m.index, ids[i + 1]?.index ?? m.index + 5000);
    const str = (key) => { const t = chunk.match(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`)); const v = t && JSON.parse(t[1]); return v && v !== '$undefined' ? v : ''; };
    // a card repeats listingId in several props; keep the occurrence that has the title
    if (str('shortTitle')) titles[m[1]] = { ...titles[m[1]], shortTitle: str('shortTitle'), subTitle: str('subTitle') };
    // card image is a scheme-less path; the rule param picks the rendition size
    const img = chunk.match(/"src":"(img\.classistatic\.de\/[^"?]+)"/);
    if (img && !titles[m[1]]?.image) titles[m[1]] = { ...titles[m[1]], image: `https://${img[1]}?rule=mo-360w` };
  });
  const RATING = { VERY_GOOD_PRICE: 'Sehr guter Preis', GOOD_PRICE: 'Guter Preis', REASONABLE_PRICE: 'Fairer Preis', INCREASED_PRICE: 'Erhöhter Preis', HIGH_PRICE: 'Hoher Preis' };
  const items = data.listings.map((l) => {
    const t = titles[l.id] || {};
    const model = l.model?.localized || null;
    return {
      id: l.id,
      type: l.type,
      attr: l.attr,
      make: l.make?.localized || null,
      model,
      shortTitle: t.shortTitle || [l.make?.localized, model].filter(Boolean).join(' '),
      subTitle: t.subTitle || '',
      previewImage: t.image ? { src: t.image } : null,
      price: { grossAmount: l.price?.grs?.amount ?? null },
      priceRating: { rating: l.priceRating?.rating, ratingLabel: RATING[l.priceRating?.rating] || null },
      contactInfo: { country: l.attr?.cn, sellerType: l.contact?.enumType === 'DEALER' ? 'DEALER' : 'PRIVATE' },
      sellerId: l.sellerId,
    };
  });
  const PER_PAGE = 20; // regular results per page; top/eyecatcher slots are extra
  return {
    searchResults: {
      items,
      numResultsTotal: data.numResultsTotal,
      numPages: Math.min(50, Math.ceil(data.numResultsTotal / PER_PAGE)),
      page: data.pageNumber,
    },
    aggregations: null,
  };
};

function collect(sr) {
  let added = 0;
  for (const item of sr.items || []) {
    if (!item.id) continue;
    if (!ads.has(item.id)) added++;
    ads.set(item.id, item);
  }
  return added;
}

async function scrapeSegment(min, max) {
  const key = `${min ?? ''}:${max ?? ''}`;
  if (progress[key]?.done) {
    console.log(`segment p=${key} already done, skipping`);
    return;
  }
  const first = await getPageState(searchUrl({ min, max, page: 1 }), extractSrp);
  const sr = first.searchResults;
  console.log(`segment p=${key} -> ${sr.numResultsTotal} results, ${sr.numPages} pages`);
  if (sr.numResultsTotal > MAX_SAFE_RESULTS && max - min > 1) {
    const mid = Math.floor((min + max) / 2);
    await scrapeSegment(min, mid);
    await scrapeSegment(mid + 1, max);
    progress[key] = { done: true };
    saveState();
    return;
  }
  collect(sr);
  const startPage = Math.max(2, (progress[key]?.lastPage || 1) + 1);
  for (let p = startPage; p <= sr.numPages; p++) {
    await sleep(jitter());
    const next = (await getPageState(searchUrl({ min, max, page: p }), extractSrp)).searchResults;
    if (next.page !== p) {
      console.log(`  ! asked page ${p}, got ${next.page} — stopping segment`);
      break;
    }
    const added = collect(next);
    progress[key] = { lastPage: p, numPages: sr.numPages };
    saveState();
    console.log(`  page ${p}/${sr.numPages}: +${added} (total unique ${ads.size})`);
  }
  progress[key] = { done: true };
  saveState();
}

(async () => {
  await launchBrowser();
  try {
    // read price percentiles from an unsegmented first page to build segments
    const probe = await getPageState(searchUrl({ page: 1 }), extractSrp);
    const total = probe.searchResults.numResultsTotal;
    console.log(`${total} listings total for make ${MAKE_ID}`);
    let segments = [[0, 10000000]];
    if (total > MAX_SAFE_RESULTS) {
      const pct = Object.assign({}, ...(probe.aggregations?.p || []));
      // the new search experience exposes no price percentiles; fall back to
      // fixed Tesla-shaped cuts (oversized segments still split recursively)
      const fromAgg = [pct['25.0'], pct['50.0'], pct['75.0'], pct['95.0']].filter(Boolean);
      const cuts = (fromAgg.length ? fromAgg : [22000, 28000, 35000, 45000])
        .map((v) => Math.round(parseFloat(v)));
      segments = [];
      let lo = 0;
      for (const cut of cuts) {
        segments.push([lo, cut]);
        lo = cut + 1;
      }
      segments.push([lo, 10000000]);
    }
    for (const [min, max] of segments) await scrapeSegment(min, max);
    console.log(`\nDONE: ${ads.size} unique listings in data/raw_ads.json`);
    console.log('next: node src/build_csv.js');
  } finally {
    saveState();
    await closeBrowser();
  }
})();
