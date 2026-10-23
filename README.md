# Kurswert

Market valuation for used Teslas in Germany. Scrapes every Tesla listing from mobile.de and AutoScout24, reads the sellers' descriptions to catch damaged or misdescribed cars, and estimates what each car is worth on the German market. A dashboard shows every listing against that estimate, flags cars priced below it, and works out the most a dealer should pay for a target resale margin.

Median error against asking prices is 3.4% in cross-validation (Model Y 2.7%, Model 3 3.3%, Model X 4.6%, Model S 6.4%). See [PRICING.md](PRICING.md) for how the engine works and [pricing/lab/REPORT.md](pricing/lab/REPORT.md) for how it was measured and improved.

## Quickstart

```bash
npm install
npx playwright install chrome   # only if Chrome isn't installed
npm run scrape                  # mobile.de, all Tesla listings -> data/raw_ads.json (~15 min)
npm run scrape-as24             # AutoScout24, 8 EU countries -> data/raw_ads_as24.json (~20 min)
npm run details                 # mobile.de detail pages: descriptions, damage field (~4-5 s per car)
npm run label                   # AI labels for trim, damage, battery, import, fleet use (needs ANTHROPIC_API_KEY)
npm run train                   # train the model, value every listing -> data/valuations.json
npm run serve                   # dashboard at http://localhost:8080 (HOST=, PORT= to change)
```

`npm run nightly` does the whole refresh in one resumable, unattended run and logs to `data/nightly.log`. Put `ANTHROPIC_API_KEY=...` in `.env.local` (gitignored) so it labels via the API. All data lives in `data/` unless `KURSWERT_DATA` points elsewhere.

All scrapers are resumable: kill and rerun, they continue from the checkpoint in `data/`. They drive a real, visible Chrome window, because mobile.de blocks headless browsers. Leave the windows alone while they run. [LEARNINGS.md](LEARNINGS.md) explains the bot protection and the approach.

Without an API key, `npm run label` queues the cars and `npm run label-claude` has Claude Code label them; until then they show as "Ungeprüft" and never as deals. [CLAUDE.md](CLAUDE.md) has the details.

## What's in the dashboard

- **Neu für dich**: every car that arrived since you last looked, newest first or best deal first. A car counts as seen after about two seconds on screen or when you open the listing; "Alle als gesehen markieren" clears the list. Seen state is stored server-side in `data/seen.json`, so it carries across restarts and devices.
- **Gesamtmarkt**: every listing from both sites with its market value, a value range, and how far the asking price sits from it. Filters for model, location and radius (German postcodes), first registration, mileage and price.
- **Chancen**: cars whose asking price is below the buy target for your margin and holding costs. Cars with damage in the description, contradictory listing data, a price more than 30% under market, or specs outside the training data are never shown as deals.
- **Neue Angebote**: the freshest mobile.de listings (`npm run value-newest`).
- **Eigener Bestand**: a dealer's own stock valued against the market (`DEALER_URL=... npm run scrape-dealer`).
- **Angebot senden**: fills a templated purchase offer into a mobile.de listing's contact form. Dry run by default; a real send needs an explicit opt-in. Only available when the server is bound to localhost. Configure it in `pricing/dealer.config.json` (copy the example).

## Other commands

```bash
npm run evaluate        # 10-fold cross-validation + agreement with mobile.de's own price ratings
npm test                # unit tests
node pricing/lab/harness.js baseline proposed   # model experiments (needs a snapshot, see the lab report)
MAKE_ID=3500 npm run scrape                     # another make on mobile.de (3500 = BMW); trims are Tesla-specific
```

## Data and attribution

Scraped data, trained models and generated JSON stay local in `data/` (gitignored). Postcode coordinates in `web/geo/plz.json` come from [GeoNames](https://www.geonames.org/) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

This is a personal research project. Check the terms of use of mobile.de and AutoScout24 before scraping them, keep request rates low (the scrapers pace themselves), and don't redistribute scraped listings.
