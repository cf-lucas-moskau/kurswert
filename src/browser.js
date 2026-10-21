// Shared browser management for mobile.de scraping.
//
// mobile.de sits behind Akamai bot protection. What gets through, and what
// does not, is documented in LEARNINGS.md. Short version: real headed Chrome
// with a fresh profile passes; the same session gets rate-limited after
// roughly 40 page loads, so we rotate to a brand-new profile every
// ROTATE_AFTER pages and whenever a block or the "new search experience"
// A/B variant shows up.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Each site gets its own profiles dir so two scrapers (mobile.de details and
// AutoScout24, say) can run at once without deleting each other's profiles.
const DEFAULTS = { profilesDir: path.join(__dirname, '..', 'profiles'), warmup: 'https://www.mobile.de/' };
const ROTATE_AFTER = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 3000 + Math.random() * 3000;

const browser = { ctx: null, page: null, profileNum: 0, pagesSinceLaunch: 0, ...DEFAULTS };

// opts.profilesDir / opts.warmup stick for later rotations within this process
async function launchBrowser(opts = {}) {
  Object.assign(browser, opts);
  if (browser.ctx) await browser.ctx.close().catch(() => null);
  browser.profileNum++;
  browser.pagesSinceLaunch = 0;
  const dir = path.join(browser.profilesDir, `profile-${browser.profileNum}`);
  fs.rmSync(dir, { recursive: true, force: true });
  browser.ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1400, height: 900 },
    locale: 'de-DE',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  browser.page = browser.ctx.pages()[0] || (await browser.ctx.newPage());
  // warm up on the homepage like a normal visitor
  await browser.page.goto(browser.warmup, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  await sleep(2500 + Math.random() * 2000);
  console.log(`  (browser profile ${browser.profileNum} ready)`);
}

async function closeBrowser() {
  if (browser.ctx) await browser.ctx.close().catch(() => null);
  fs.rmSync(browser.profilesDir, { recursive: true, force: true });
}

// Navigate to url and run extractFn (a serializable function) in the page.
// Returns whatever extractFn returns once it is truthy. Handles 403s,
// soft-blocks and the new-experience A/B redirect by rotating profiles.
async function getPageState(url, extractFn) {
  if (browser.pagesSinceLaunch >= ROTATE_AFTER) {
    console.log('  (proactive profile rotation)');
    await launchBrowser();
  }
  for (let attempt = 1; attempt <= 8; attempt++) {
    let status = 0;
    try {
      const resp = await browser.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      status = resp.status();
      // 410 Gone / 404 = listing permanently removed (sold/deleted) — don't retry
      if (status === 410 || status === 404) {
        const err = new Error(`gone:${status}`);
        err.gone = true;
        throw err;
      }
      if (status === 200) {
        await browser.page.waitForFunction(extractFn, { timeout: 20000 }).catch(() => null);
        const result = await browser.page.evaluate(extractFn);
        if (result) {
          browser.pagesSinceLaunch++;
          browser.consecutiveBlocks = 0; // IP flag has cleared
          return result;
        }
        const title = await browser.page.title().catch(() => '?');
        if (title.includes('PKW-Suche')) {
          // this profile was assigned the new search experience (A/B test),
          // which lacks the embedded state — a new profile rerolls the assignment
          console.log('  landed in new search experience, rotating profile');
          await sleep(3000);
          await launchBrowser();
          continue;
        }
        console.log(`  no data extracted (title="${title}")`);
      }
    } catch (e) {
      if (e.gone) throw e; // permanently removed — let the caller mark it gone
      console.log(`  nav error: ${e.message.split('\n')[0]}`);
    }
    if ((status === 403 && attempt >= 2) || attempt >= 3) {
      // When fresh profiles keep getting 403, the block is IP-level, not
      // session-level — rotating faster won't help. Back off progressively
      // (up to 8 min) so the IP flag can decay; reset once a 200 comes through.
      browser.consecutiveBlocks = (browser.consecutiveBlocks || 0) + 1;
      const backoff = Math.min(30000 * browser.consecutiveBlocks, 480000);
      console.log(`  retry ${attempt}/8 (status ${status}), rotating + backoff ${Math.round(backoff / 1000)}s (consec blocks ${browser.consecutiveBlocks})`);
      await sleep(backoff);
      await launchBrowser();
    } else {
      const cooldown = status === 403 ? 30000 : 8000 * attempt;
      console.log(`  retry ${attempt}/8 (status ${status}), cooling down ${Math.round(cooldown / 1000)}s`);
      await sleep(cooldown);
    }
  }
  throw new Error(`failed to load ${url}`);
}

module.exports = { launchBrowser, closeBrowser, getPageState, sleep, jitter };
