// Visits each listing's detail page and saves the full embedded ad object
// (spec attributes, equipment list, seller description, dealer address with
// coordinates, gallery images, battery info, price rating thresholds).
//
// Reads ids from data/raw_ads.json, checkpoints into data/raw_details.json
// after every ad — kill and rerun to resume. Already-fetched ads are skipped.
//
// Usage:
//   node src/fetch_details.js            # all missing ads (slow: ~4-5s each)
//   LIMIT=10 node src/fetch_details.js   # test run
const fs = require('fs');
const path = require('path');
const { launchBrowser, closeBrowser, getPageState, sleep, jitter } = require('./browser');

const DATA = path.join(__dirname, '..', 'data');
const RAW = path.join(DATA, 'raw_ads.json');
const DETAILS = path.join(DATA, 'raw_details.json');
const LIMIT = parseInt(process.env.LIMIT || '0', 10);

const ads = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const details = fs.existsSync(DETAILS) ? JSON.parse(fs.readFileSync(DETAILS, 'utf8')) : {};

// NEWEST_ONLY=1 restricts the fetch to the fresh arrivals recorded by
// value_newest (data/newest_ids.json), so vetting new cars stays fast and
// doesn't pull in the whole backlog. Default: fetch every not-yet-fetched id.
let candidateIds = ads.map((a) => a.id);
if (process.env.NEWEST_ONLY === '1') {
  const nf = path.join(DATA, 'newest_ids.json');
  const newest = fs.existsSync(nf) ? new Set(JSON.parse(fs.readFileSync(nf, 'utf8')).ids.map(String)) : new Set();
  candidateIds = candidateIds.filter((id) => newest.has(String(id)));
  console.log(`NEWEST_ONLY: limiting to ${candidateIds.length} fresh-arrival ids`);
}
// gone = listing was removed from mobile.de between scrape and detail fetch
const country = Object.fromEntries(ads.map((a) => [a.id, a.attr?.cn]));
// German listings first: they train the market model, so their labels matter most
const pending = candidateIds
  .filter((id) => !(id in details))
  .sort((a, b) => (country[b] === 'DE') - (country[a] === 'DE'));
console.log(`${ads.length} ads, ${Object.keys(details).length} already fetched, ${pending.length} pending`);

// Runs in the page. Classic VIP (__INITIAL_STATE__) or the Next.js page
// mobile.de serves everyone since Oct 2026, where the same ad object sits in the
// RSC flight payload as the `listing` prop and long strings (the seller
// description) are split into separate text rows referenced as "$<id>".
const extractVip = () => {
  const vip = window.__INITIAL_STATE__?.search?.vip;
  const cur = vip?.current?.adId;
  const entry = cur != null && vip?.ads?.[cur];
  if (entry?.data?.ad) return { ad: entry.data.ad };
  if (entry?.status && entry.status !== 'loading') return { gone: true, status: entry.status };

  // inline <script> tags, not self.__next_f: post-hydration chunks skip the array
  const PREFIX = 'self.__next_f.push(';
  const s = [...document.querySelectorAll('script:not([src])')]
    .map((el) => el.textContent)
    .filter((t) => t.startsWith(PREFIX))
    .map((t) => { try { const c = JSON.parse(t.slice(PREFIX.length, t.lastIndexOf(')'))); return typeof c[1] === 'string' ? c[1] : ''; } catch { return ''; } })
    .join('');
  // the ad is the `listing` prop that carries attributes; key order varies
  // (new-car ads start with "isOnStock"), so try each `"listing":{` in turn
  const objectAt = (start) => {
    let depth = 0, inStr = false, end = start;
    for (; end < s.length; end++) {
      const ch = s[end];
      if (inStr) { if (ch === '\\') end++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
    }
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; } // still streaming
  };
  let ad = null;
  for (let at = s.indexOf('"listing":{'); at >= 0 && !ad; at = s.indexOf('"listing":{', at + 1)) {
    const obj = objectAt(at + '"listing":'.length);
    if (Array.isArray(obj?.attributes)) ad = obj;
  }
  if (!ad) return null;
  // text row "<id>:T<hex byte length>,<text>"; the length counts UTF-8 bytes
  const textRow = (ref) => {
    const m = typeof ref === 'string' && ref.match(/^\$([0-9a-f]+)$/);
    if (!m) return ref;
    const head = new RegExp(`(^|\\n)${m[1]}:T([0-9a-f]+),`).exec(s);
    if (!head) return null;
    const bytes = new TextEncoder().encode(s.slice(head.index + head[0].length));
    return new TextDecoder().decode(bytes.slice(0, parseInt(head[2], 16)));
  };
  ad.htmlDescription = textRow(ad.htmlDescription);
  // classic shape downstream code expects
  if (ad.price?.grs && ad.price.grossAmount == null) ad.price.grossAmount = ad.price.grs.amount;
  if (ad.make?.localized) ad.make = ad.make.localized;
  if (ad.model?.localized) ad.model = ad.model.localized;
  if (ad.contact && !ad.contactInfo) ad.contactInfo = { ...ad.contact, sellerType: ad.contact.enumType === 'DEALER' ? 'DEALER' : 'PRIVATE' };
  if (ad.images && !ad.galleryImages) ad.galleryImages = ad.images.map((i) => ({ src: `https://${i.uri}?rule=mo-1024w` }));
  return { ad };
};

(async () => {
  await launchBrowser();
  let fetched = 0;
  try {
    for (const id of pending) {
      if (LIMIT && fetched >= LIMIT) break;
      await sleep(jitter());
      const url = `https://suchen.mobile.de/fahrzeuge/details.html?id=${id}`;
      try {
        const result = await getPageState(url, extractVip);
        if (result.gone) {
          details[id] = { gone: true };
          console.log(`  ${id}: gone (${result.status})`);
        } else {
          // strip the heaviest repeated blobs we don't need
          const ad = result.ad;
          delete ad.similarAdsInfo;
          delete ad.serviceLinks;
          delete ad.partnerLinks;
          details[id] = ad;
        }
      } catch (e) {
        if (e.gone) {
          // permanently removed (410/404) — record so we don't re-attempt every run
          details[id] = { gone: true };
          console.log(`  ${id}: gone (${e.message})`);
        } else {
          console.log(`  ${id}: FAILED (${e.message.split('\n')[0]}) — will retry on next run`);
        }
      }
      fetched++;
      fs.writeFileSync(DETAILS, JSON.stringify(details));
      if (fetched % 10 === 0) console.log(`progress: ${fetched}/${LIMIT || pending.length} this run, ${Object.keys(details).length} total`);
    }
    console.log(`\nDONE this run: ${fetched} fetched, ${Object.keys(details).length}/${ads.length} total in data/raw_details.json`);
    console.log('next: node src/build_details_csv.js');
  } finally {
    fs.writeFileSync(DETAILS, JSON.stringify(details));
    await closeBrowser();
  }
})();
