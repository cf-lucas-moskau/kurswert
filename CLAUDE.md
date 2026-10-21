# Kurswert: guide for Claude Code

This project scrapes used-Tesla listings from mobile.de and AutoScout24 and runs
a market valuation engine + dashboard ("Kurswert") on top of them.
This file tells you (Claude Code) how to operate it on any machine. The user
drives everything through you — when they ask to "refresh", "add new cars",
"send an offer", etc., map it to the workflows below.

## What's here

- `src/` — the scraper (Playwright, headed Chrome). Reads listings and detail pages.
- `pricing/` — the valuation engine, trainer, evaluator, AI labeling, offer sender.
- `web/` — the dashboard (static page + tiny server with a send-offer endpoint).
- `data/` — all scraped + generated data (gitignored; regenerate on a fresh clone).
- `LEARNINGS.md` — how the scraper gets past mobile.de's bot protection.
- `PRICING.md` — how the valuation engine works and how it's validated.

## First-time setup on a new machine

Run these once, and tell the user what each needs:

1. `npm install` — installs Playwright and the Anthropic SDK.
2. Chrome must be present. The scraper uses real headed Chrome (`channel: 'chrome'`);
   headless is blocked by mobile.de. If Chrome isn't installed, run
   `npx playwright install chrome`.
3. For AI labeling (`npm run label`) you need Claude API access: either
   `ANTHROPIC_API_KEY` in the environment, or `ant auth login`. If neither is
   available, you (Claude Code) can do the labeling yourself with subagents —
   see "Labeling without an API key" below.
4. A fresh clone has no `data/` (it's gitignored). Bootstrap it by scraping (step 1
   of the pipeline).

Chrome windows are visible while any scraper runs. That's expected — leave them
alone; don't try to run headless.

## The pipeline (run in this order)

```
npm run scrape        # 1. all German+EU Tesla listings -> data/raw_ads.json  (~15 min, resumable)
npm run scrape-as24   # 1b. AutoScout24 Teslas (8 EU countries) -> data/raw_ads_as24.json (~20 min)
npm run details       # 2. visit each detail page for descriptions -> data/raw_details.json (~4-5s/car, resumable)
npm run label         # 3. AI-label trims + damage from descriptions -> data/labels.json (needs API key; resumable)
npm run train         # 4. train the market model + build web/valuations.json
npm run value-newest  # 5. fetch freshest arrivals + value them -> web/newest.json
DEALER_URL=... npm run scrape-dealer # 6. scrape + value a dealer's own inventory -> web/dealer.json
npm run serve         # 7. dashboard at http://localhost:8080
```

Steps 2 and 3 are the data-quality layer and are the slowest. Steps 4-7 are fast
and safe to re-run anytime. `npm run evaluate` prints the engine's accuracy;
`npm test` runs the unit tests.

## Common requests → what to do

- **"Refresh the market / re-scrape"**: `rm data/raw_ads.json data/progress.json`,
  then run steps 1→7. Details and labels for still-listed cars are keyed by id and
  survive, so only new cars need re-fetching/labeling.
- **"Show me / get the newest cars" / "fetch the freshest"**: ALWAYS run the full
  four-step vetting, never just the fetch — the user wants every new arrival fully
  checked for damage and correct trim before it shows up as a deal:
  ```
  npm run value-newest   # fetch freshest + merge them into data/raw_ads.json
  npm run details        # detail pages for the newly-merged ids
  npm run label          # AI trim/damage labels for the new ids (or subagents if no API key)
  npm run train          # retrain + rebuild web/newest.json WITH labels/flags
  ```
  `value-newest` now merges the fresh listings into the dataset and records their
  order in `data/newest_ids.json`; `train` rebuilds the New-arrivals feed from the
  labeled valuations. Skipping details/label/train leaves the new cars unvetted
  (no damage flags, title-parsed trim only) — don't stop after value-newest.
- **"Add labels for new cars" / "clean the data"**: `npm run details` then
  `npm run label` (only unlabeled cars are processed), then `npm run train`.
- **"Send an offer on car X"**: `npm run send-offer <listingId>` — this DRY-RUNS
  (fills the mobile.de contact form, screenshots it, does not send). Only add
  `SEND=1` after the user explicitly confirms, and only after a one-time
  `LOGIN=1 npm run send-offer` to log into their mobile.de account. Never send for
  real without explicit per-offer confirmation.
- **"Recalibrate to a real offer"**: edit `pricing/calibration.json` with the
  listing id and the amount the dealer offered, then `npm run train`. The implied
  margin becomes the dashboard default.
- **"Value a different make" (not Tesla)**: `MAKE_ID=<id> npm run scrape` (make ids
  are in the search page; e.g. BMW=3500). The engine and labeling adapt, but the
  trim taxonomy in `pricing/features.js` is Tesla-specific — revisit it.

## Labeling without an API key

`npm run label` calls the Claude API. If there's no `ANTHROPIC_API_KEY` / `ant`
login, do the labeling yourself: read `data/raw_details.json` (each entry's
`htmlDescription` plus the `damageCondition` attribute), and for each car produce
the same JSON `label.js` would — `{trueTrim, trimConfidence, condition,
batteryIssue, isImport, commercialUse, priceCaveats}` — and write it to
`data/labels.json` keyed by listing id. Fan this out across subagents for speed
(one chunk each, each returning JSON you merge). The schema and the labeling rules
are documented at the top of `pricing/label.js` — follow them exactly, especially:
a "Long Range" with an acceleration boost is NOT a real Performance.

## Safety and etiquette

- **Offers are real outbound messages.** `send_offer.js` is dry-run by default; a
  real send needs `SEND=1` plus explicit user confirmation for that specific car.
- **Don't hammer mobile.de.** The scrapers already pace themselves and rotate
  browser profiles (see LEARNINGS.md). Don't lower the delays or parallelize the
  mobile.de scrapers.
- **Scraper Chrome must stay headed.** Headless is detected and blocked.
- Regenerated data and the trained model are gitignored — commit code and docs,
  not `data/`, `web/*.json`, or `pricing/model.json`.

## How the pieces fit (as of Oct 2026)

- mobile.de serves its new Next.js pages to everyone. Search results and detail
  pages are read from the RSC flight payload in the inline `<script>` tags (not
  `self.__next_f`, which loses chunks after hydration) and mapped to the classic
  ad shape, so features/train/labels see the same fields as before.
- `pricing/load_ads.js` merges mobile.de + AutoScout24, drops cross-posts
  (same model + first reg, km ±1%, price ±3%) and repeat postings of one car
  within a site (dealer chains list each car at every branch).
- Training uses German mobile.de listings only (`makeTrainingFilter`):
  AutoScout24 states power on a different basis and did not improve accuracy.
  AutoScout24 cars are still valued and shown in the dashboard, but have no
  detail pages or labels.
- The engine is ridge regression + nearest-comparables correction + boosted
  trees (`pricing/gbm.js`), blended in log space. `pricing/lab/` holds the
  experiment harness and REPORT.md; use it before changing the model.
- Safety rules: a title stating a different build year or power overrides the
  field (`corrections`); a car 30%+ under market is `implausiblePrice` and never
  a deal; extreme km per year counts as outside the data.
- Labels written by Claude Code subagents carry `labeledBy: 'claude-code-subagent'`.

## If something breaks

- Scraper returns the search form instead of results, or 403s: read LEARNINGS.md
  (Akamai bot protection, profile rotation, the A/B "new search experience" trap).
- Valuations look wrong after a change: `npm test` (engine unit tests) and
  `npm run evaluate` (cross-validation + agreement with mobile.de's own ratings).
- A "great deal" that's actually damaged: that's what the labeling layer prevents —
  make sure `npm run details` + `npm run label` have run for that car, then
  `npm run train`.
