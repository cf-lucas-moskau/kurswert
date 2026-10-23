// Sends a templated purchase offer to a mobile.de listing's seller, with the
// engine's suggested price filled in automatically.
//
//   node pricing/send_offer.js <listingId> [offerPrice]
//
// SAFETY: this is a real outbound message. It DRY-RUNS by default — it fills the
// whole form and screenshots it but does NOT click send. To actually send, set
// SEND=1. Nothing is sent without that explicit opt-in.
//
// LOGIN: uses a persistent browser profile at profiles/mobile-session. Run once
// with LOGIN=1 to open mobile.de and log in as the dealer; the session persists,
// so later sends go out from the dealer's account (name/email prefilled).
//
//   LOGIN=1 node pricing/send_offer.js         # one-time: log in, then close
//   node pricing/send_offer.js 459551472 21800 # dry-run: fill offer, screenshot
//   SEND=1 node pricing/send_offer.js 459551472 21800  # actually send
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { valuate } = require('./engine');
const { dataFile } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(ROOT, 'profiles', 'mobile-session'); // NOT wiped — holds the login
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  const p = path.join(__dirname, 'dealer.config.json');
  const ex = path.join(__dirname, 'dealer.config.example.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log('(no dealer.config.json — using dealer.config.example.json; copy and edit it for real use)');
  return JSON.parse(fs.readFileSync(ex, 'utf8'));
}

async function launch() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: false, viewport: { width: 1400, height: 900 },
    locale: 'de-DE', args: ['--disable-blink-features=AutomationControlled'],
  });
  return { ctx, page: ctx.pages()[0] || (await ctx.newPage()) };
}

async function acceptCookies(page) {
  await page.getByRole('button', { name: /Einverstanden|Alle akzeptieren/i }).first().click().catch(() => {});
  await sleep(800);
}

// one-time login helper
async function doLogin() {
  const { ctx, page } = await launch();
  await page.goto('https://www.mobile.de/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptCookies(page);
  console.log('\nLog in to mobile.de in the browser window, then press Enter here to save the session…');
  await new Promise((r) => process.stdin.once('data', r));
  await ctx.close();
  console.log('session saved to profiles/mobile-session');
}

function buildMessage(cfg, listing, offer) {
  return cfg.messageTemplate
    .replace(/{title}/g, `${listing.title || listing.model} ${listing.variant || ''}`.trim())
    .replace(/{trim}/g, listing.trim || '')
    .replace(/{year}/g, listing.year || '')
    .replace(/{mileage}/g, (listing.mileageKm ?? '').toLocaleString('de-DE'))
    .replace(/{offer}/g, offer.toLocaleString('de-DE'))
    .replace(/{market}/g, (listing.marketPrice ?? '').toLocaleString('de-DE'));
}

async function sendOffer(listingId, offerArg) {
  const cfg = loadConfig();
  // find the listing + its valuation from the newest feed or full valuations
  const feeds = ['newest.json', 'valuations.json'].map(dataFile);
  let listing = null;
  for (const f of feeds) {
    if (!fs.existsSync(f)) continue;
    listing = JSON.parse(fs.readFileSync(f, 'utf8')).listings.find((l) => String(l.id) === String(listingId));
    if (listing) break;
  }
  if (!listing) throw new Error(`listing ${listingId} not found in newest.json or valuations.json — run train / value-newest first`);

  // offer = explicit arg, else the max buy price at the dealer's margin
  const offer = offerArg ? parseInt(offerArg, 10) : Math.round(listing.marketPrice / (1 + (cfg.marginPct ?? 0.15)));
  const message = buildMessage(cfg, listing, offer);
  const dry = process.env.SEND !== '1';

  console.log(`\nListing : ${listing.title} ${listing.variant || ''} (${listingId})`);
  console.log(`Market  : ${listing.marketPrice?.toLocaleString('de-DE')} EUR`);
  console.log(`Offer   : ${offer.toLocaleString('de-DE')} EUR`);
  console.log(`Mode    : ${dry ? 'DRY RUN (will NOT send)' : 'SEND (will submit the form)'}`);
  console.log(`--- message ---\n${message}\n---------------`);

  const { ctx, page } = await launch();
  try {
    await page.goto(`https://www.mobile.de/checkout/core/${listingId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await acceptCookies(page);
    await page.waitForSelector('textarea[name="message"], #message', { timeout: 20000 });

    // salutation (COMPANY = Firma if present, else Herr)
    const salIdx = { MR: 0, MRS: 1, COMPANY: 2 }[cfg.salutation] ?? 0;
    await page.locator('input[name="salutation"]').nth(salIdx).check().catch(() => {});
    // fill only empty fields, so a logged-in dealer's prefilled data is kept
    const fill = async (sel, val) => {
      if (!val) return;
      const el = page.locator(sel).first();
      if (await el.count() === 0) return;
      if (!(await el.inputValue().catch(() => ''))) await el.fill(String(val)).catch(() => {});
    };
    await fill('#firstName, input[name="firstName"]', cfg.firstName);
    await fill('#lastName, input[name="lastName"]', cfg.lastName);
    await fill('#email, input[name="email"]', cfg.email);
    await fill('#phoneNumber, input[name="phoneNumber"]', cfg.phoneNumber);
    // message: always replace with our templated offer
    await page.locator('textarea[name="message"], #message').first().fill(message);
    await sleep(500);

    const shot = path.join(ROOT, `offer-${listingId}.png`);
    await page.screenshot({ path: shot });
    console.log(`filled form screenshot: ${shot}`);

    if (dry) {
      console.log('\nDRY RUN complete — nothing sent. Re-run with SEND=1 to submit.');
    } else {
      await page.getByRole('button', { name: /E-Mail senden/i }).first().click();
      await sleep(4000);
      await page.screenshot({ path: path.join(ROOT, `offer-${listingId}-sent.png`) });
      console.log('\nSENT. Confirmation screenshot saved.');
    }
  } finally {
    await ctx.close();
  }
}

(async () => {
  if (process.env.LOGIN === '1') return doLogin();
  const [, , listingId, offerArg] = process.argv;
  if (!listingId) {
    console.log('usage: node pricing/send_offer.js <listingId> [offerPrice]   (LOGIN=1 to log in first; SEND=1 to actually send)');
    process.exit(1);
  }
  await sendOffer(listingId, offerArg);
})();
