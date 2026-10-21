// Scrapes a dealer's own Tesla inventory from their website and values each
// car against the engine. Their prices are retail asking prices, so this shows
// where their own stock sits vs the wider market. Output: web/dealer.json
//
//   DEALER_URL=https://www.example-autohaus.de/angebote/ node pricing/scrape_dealer.js
//
// The selectors below match one common German dealer-website layout (cards
// linking to /angebote/Tesla/<id>, prices like "29.990,- €"); adapt them for
// another site.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { valuate } = require('./engine');
const { classifyTrim, REFERENCE_DATE } = require('./features');

const ROOT = path.join(__dirname, '..');
const INVENTORY_URL = process.env.DEALER_URL;
if (!INVENTORY_URL) {
  console.error('Set DEALER_URL to the dealer inventory page, e.g. DEALER_URL=https://www.example-autohaus.de/angebote/');
  process.exit(1);
}
const model = JSON.parse(fs.readFileSync(path.join(__dirname, 'model.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a synthetic ad in the shape featurize()/valuate() expect, from the
// dealer's own listing fields (they list power inconsistently, so estimate kW
// from the trim when absent).
function toAd(l) {
  const kwGuess = /performance|plaid/i.test(l.title) ? 340 : /long range|awd/i.test(l.title) ? 250 : 210;
  return {
    id: l.id,
    model: l.model,
    shortTitle: l.model,
    subTitle: l.title,
    price: { grossAmount: l.price },
    attr: {
      fr: l.year ? `01/${l.year}` : null,
      ml: l.km != null ? `${l.km} km` : null,
      pw: `${kwGuess} kW`,
      cn: 'DE',
    },
  };
}

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(ROOT, 'profiles', 'dealer'), {
    channel: 'chrome', headless: false, viewport: { width: 1400, height: 1000 }, locale: 'de-DE',
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto(INVENTORY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('button', { name: /akzeptieren/i }).first().click().catch(() => {});
    await sleep(1500);
    // load everything: scroll to trigger lazy-loading, then click a pagination
    // "more/next" control if one exists (short timeout so a missing control
    // doesn't stall the loop)
    let prevCount = 0;
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 5000);
      await sleep(700);
      await page.getByRole('link', { name: /weiter|nächste|mehr anzeigen/i }).first().click({ timeout: 1200 }).catch(() => {});
      const count = await page.locator('a[href*="/angebote/Tesla/"]').count();
      if (count === prevCount && i > 3) break; // no new cars loading
      prevCount = count;
    }
    const raw = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/angebote/Tesla/"]')) {
        const idM = a.href.match(/\/(\d+)(?:\/)?$/);
        const id = idM ? idM[1] : a.href;
        if (seen.has(id)) continue;
        // walk up to the card container that includes both price and mileage
        let node = a, t = '';
        for (let i = 0; i < 10 && node; i++) {
          node = node.parentElement;
          if (!node) break;
          const txt = node.innerText || '';
          if (/,-\s*€/.test(txt) && /\bkm\b/.test(txt)) { t = txt.replace(/\s+/g, ' ').trim(); break; }
        }
        if (!t) continue;
        const priceM = t.match(/([\d.]+),-\s*€/);
        const modelM = t.match(/Model\s+([3YSX])/i);
        if (!priceM || !modelM) continue;
        seen.add(id);
        const titleM = t.match(/Tesla\s+Model\s+[3YSX][^|]*?(?=\s+Barpreis)/i);
        out.push({
          id,
          url: a.href,
          model: `Model ${modelM[1].toUpperCase()}`,
          title: (titleM ? titleM[0] : `Tesla Model ${modelM[1]}`).replace(/^Tesla\s+/, '').trim(),
          price: parseInt(priceM[1].replace(/\./g, ''), 10),
          km: (t.match(/([\d.]+)\s*km/) || [])[1] ? parseInt((t.match(/([\d.]+)\s*km/) || [])[1].replace(/\./g, ''), 10) : null,
          year: (t.match(/\b(20\d{2})\b/) || [])[1] || null,
          vat: /inkl\. 19% MwSt|Mwst\. ausweisbar/i.test(t),
        });
      }
      return out;
    });

    const listings = raw.map((l) => {
      const v = valuate(model, toAd(l), 0.15);
      const trim = classifyTrim(l.model, l.title).label;
      return { ...l, trim, marketPrice: v.marketPrice, low: v.low, high: v.high,
        deltaPct: v.deltaPct, confidence: v.confidence, extrapolated: v.extrapolated };
    });
    fs.mkdirSync(path.join(ROOT, 'web'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'web', 'dealer.json'),
      JSON.stringify({ source: new URL(INVENTORY_URL).hostname, count: listings.length, listings }));
    console.log(`scraped + valued ${listings.length} dealer listings -> web/dealer.json`);
  } finally {
    await ctx.close();
    fs.rmSync(path.join(ROOT, 'profiles', 'dealer'), { recursive: true, force: true });
  }
})();
