# Scraping mobile.de: what works and why

Written 2026-07-14 after successfully pulling all 1594 Tesla listings (1123 in Germany) into a CSV. Everything here was verified against the live site that day.

## The short version

mobile.de is protected by Akamai, but every classic search-results page and every detail page embeds its full data as JSON in `window.__INITIAL_STATE__`. So the winning approach is: drive real headed Chrome with Playwright, navigate like a normal visitor, and read the embedded JSON. No HTML parsing, no hidden API reverse-engineering.

## What gets blocked

Verified by trying each one:

1. curl gets 403 immediately, regardless of headers. Same for mobile.de's mobile JSON API (`m.mobile.de/svc/s/`).
2. Headless Chrome (including the Playwright MCP browser) gets 403 on the first request. Akamai fingerprints the browser.
3. Headed real Chrome (`channel: 'chrome'`, `headless: false`, fresh persistent profile, `--disable-blink-features=AutomationControlled`) passes cleanly.
4. But a passing session gets rate-limited after roughly 40 page loads: hard 403s that persist for at least 15 minutes on that session. The block is tied to the browser profile (cookies), not the IP. A brand-new profile directory passes again immediately, from the same IP, even on the exact URL that was just blocked.

Consequences baked into `src/browser.js`:

- Rotate to a fresh profile directory every 15 page loads, before Akamai gets suspicious.
- On a 403, retry once, then rotate instead of waiting out the cooldown.
- 3-6s randomized delay between page loads, and a homepage warm-up visit after each launch.

## The A/B test trap

Fresh profiles are randomly assigned to mobile.de's new search experience (title contains "PKW-Suche", breadcrumb "Meine Pkw-Suche", plus a GDPR consent wall). That page renders results client-side and does NOT expose `__INITIAL_STATE__.search`. It looks like a soft-block but is just an experiment bucket. Detection: HTTP 200 but no search state and title contains "PKW-Suche". Fix: rotate to a new profile, which rerolls the assignment. The classic experience has been the common bucket so far; a couple of rerolls always landed there.

**Update Oct 2026:** the new experience is now served to every profile, so rerolling no longer helps. The data is still in the HTML: the Next.js RSC flight payload sits in inline `<script>self.__next_f.push([1,"..."])</script>` tags. Search pages carry an object `{"numResultsTotal":N,"listings":[...],"pageNumber":P}` (same `attr` codes as before, price under `price.grs.amount`, titles only in the rendered card props next to each `listingId`). Detail pages carry the full ad as a `"listing":{...}` prop, with the seller description split into a separate text row referenced as `"$<id>"` (`<id>:T<hex byte length>,<text>`). Read the script tags, not the `self.__next_f` array: after hydration Next.js swaps `push` for a callback and later chunks never reach the array. `src/scrape.js` and `src/fetch_details.js` map both back to the classic shapes.

## Where the data lives

Search results page (`suchen.mobile.de/fahrzeuge/search.html`):

```
window.__INITIAL_STATE__.search.srp.data.searchResults
  .numResultsTotal, .numPages, .page, .items[]
window.__INITIAL_STATE__.search.srp.data.aggregations
  .p = price percentiles (1/5/25/50/75/95/99) — used for auto-segmentation
```

Each item with an `id` is an ad (items without `id` are ad slots / banners). Ads carry: price (`price.grossAmount`), `attr` (zip, city, country, first registration `fr`, power `pw`, fuel `ft`, mileage `ml`, transmission `tr`, color `ecol`, battery `bc`, doors, seats, category), `contactInfo` (dealer name, phone, rating, seller type), `priceRating`, `make`, `model`, title/subtitle, image URLs.

Detail page (`suchen.mobile.de/fahrzeuge/details.html?id=<id>`):

```
window.__INITIAL_STATE__.search.vip.ads[<id>].data.ad
```

Much richer: `attributes` (full spec table incl. trim line, previous owners, plug types, interior, weight, HU), `features` (complete equipment list), `htmlDescription` (seller text), `contactInfo` with street address, `latLong`, opening hours and homepage, `galleryImages` (all image URLs), `batteryInformation`, `priceRating` with market price thresholds, `financePlan`.

## Pagination cap and price segmentation

The SRP paginates at most 50 pages (~20 ads per page), whatever the result count. To get everything above ~1000 results, split the search into price bands via the `p=min:max` URL param. `src/scrape.js` does this automatically: it reads the price percentiles from the first page's aggregations, builds 5 bands, and recursively halves any band that still exceeds ~900 results. Sorting by price ascending (`sb=p&od=up`) keeps the order stable while paginating; dedup by ad id handles the rest.

Useful URL params: `ms=135;;;` (make id; Tesla=135, model id goes in the second slot), `p=min:max` price band, `pageNumber=N`, `vc=Car`, `sb=p&od=up` sort. Make ids are embedded in the search page's makes list (`"i":135,"n":"Tesla"`).

Note: results include EU-wide inventory, not just Germany. Filter on the country column (`attr.cn === 'DE'`) if you want Germany only.

## Operational notes

- Both scrapers checkpoint after every page/ad and resume on rerun. Kill them freely.
- Expect a listing count drift of a few ads over a run (listings appear/disappear live).
- Detail fetching costs ~4-5s per ad plus a rotation pause every 15 ads: budget ~2.5h per 1500 ads.
- Raw JSON is kept (`data/raw_ads.json`, `data/raw_details.json`) so CSV columns can be changed without re-scraping.
- Chrome windows are visible while scraping (headless gets blocked). Don't interact with them.

## How to refresh / extend

- Refresh listings: `rm data/raw_ads.json data/progress.json && npm run scrape && npm run csv`
- Refresh details for new listings only: `npm run details` (skips ids already in raw_details.json)
- Full detail refresh: `rm data/raw_details.json && npm run details`
- Another make: `MAKE_ID=3500 npm run scrape` (BMW). Everything else adapts automatically.
- More columns: edit `src/build_csv.js` / `src/build_details_csv.js` and rerun — no scraping needed.

## If it breaks

Check in this order: (1) screenshot in `fail-*.png` — is it a consent wall, a captcha, or a redesign? (2) Does `window.__INITIAL_STATE__` still exist on a manually opened results page? If mobile.de moves the SRP fully to the new experience, the extraction functions in `src/scrape.js` (`extractSrp`) and `src/fetch_details.js` (`extractVip`) need new state paths — find them via DevTools on a listing page. The rotation/retry machinery in `src/browser.js` should survive a redesign untouched.
