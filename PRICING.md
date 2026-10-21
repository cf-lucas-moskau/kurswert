# Market-price engine

Automated used-car valuation for a dealer: given a car's details, estimate what
it is worth on the German market, compare against the asking price, and given a
target resale margin tell the dealer the most they should pay.

## Dealer workflow

```
new listings hit the market  ─▶  engine values each vs German market  ─▶  dealer sets margin  ─▶  buy targets + deal flags
   (value_newest.js)                     (engine.js)                        (web UI slider)
```

1. `npm run scrape` + `npm run train` build the German-market model from the
   current listing population.
2. `npm run value-newest` fetches the freshest listings and values them.
3. `npm run serve`, open http://localhost:8080, drag the margin slider.

Everything is derived from the current scrape, so re-running `train` after a new
scrape re-prices the whole market. The model has no hard-coded prices.

## How the engine works

Used-car value is driven by model, age, mileage, power and trim. Prices are
modelled in **log space** (`engine.js`), because depreciation is multiplicative
(a car loses a *percentage* per year, not a fixed euro amount) and value is
strictly positive. The fit is a ridge-regularized linear regression on:

- age, age² — depreciation curve (convex: steep early, flatter later)
- mileage, mileage² — wear, with the squared term bending down the extreme-km tail
- power (kW) — proxy for trim/performance
- trim flags — AWD, Performance, Plaid, Long Range (see trim taxonomy below)

### Trim taxonomy (the main Tesla value driver)

`classifyTrim(model, title)` in `features.js` parses the listing title into a
canonical trim, which is both shown in the UI and fed to the model:

- **Model 3 / Y**: Standard Range, Standard Range Plus, Long Range, Performance
- **Model S / X**: battery tiers 75/85/90/100 (with `D` = dual-motor AWD),
  Performance (P.. / Ludicrous), and Plaid (top). "Maximale Reichweite" maps to
  Long Range.

Adding the richer trim features (over the original 3 flags) cut Model X error
from 10.3% to 8.5% and Model S from 10.9% to 9.7% — the models where trim spread
is widest.

Two tiers, so it degrades gracefully:

- **per-model regression** for models with ≥40 listings (Model 3/Y/S/X) —
  captures model-specific depreciation;
- **pooled global regression** with model dummies as the fallback for sparse
  models (Roadster etc.), so they still borrow the shared age/mileage slopes.

Robustness details that matter in practice:

- **Outlier-resistant fit**: after a first pass, listings more than 2.5σ off in
  log space (mispriced ads, data errors) are dropped and the model refits. One
  absurd listing moves the market estimate <2% (tested).
- **Log-retransformation bias** is corrected with Duan's smearing estimator, so
  `exp()` of the log fit is not systematically low.
- **Extrapolation flag**: a car beyond the model's training support (age/mileage
  above the 97.5th percentile of its cohort) is marked `extrapolated`, its
  confidence band widens, and it is *not* asserted as a confident deal — the
  engine says "I'm guessing here, verify it" instead of inventing a bargain.

## AI labeling layer (data cleanliness)

The biggest valuation errors come from facts hidden in the seller's free text, not
the structured fields: a "Basic Performance" that is really a Long Range with an
acceleration boost, or a clean-looking listing whose description says the battery
is defective. Regex can't read those; an LLM can.

`pricing/label.js` sends each car's title, subtitle, specs, the structured damage
field, and the seller description to Claude and gets back structured labels:
`trueTrim`, `trimConfidence`, `condition` (clean / repaired_damage /
accident_unrepaired / not_roadworthy / salvage), `batteryIssue`, `isImport`,
`commercialUse`, `priceCaveats`. Cached in `data/labels.json`, resumable, only new
cars are labeled. Needs `ANTHROPIC_API_KEY`; defaults to Haiku (cheap, strong at
extraction), override with `LABEL_MODEL`. Without a key, Claude Code can produce
the same labels via subagents — see `CLAUDE.md`.

The labels feed the engine three ways:

- **Corrected trim**: `trueTrim` overrides the title-parsed trim (so a boosted
  Long Range is priced as a Long Range, not a Performance).
- **Clean-only training**: cars labeled with accident/defect/salvage are excluded
  from the market fit, so damaged listings don't drag the clean-market benchmark
  down.
- **Deal flagging**: a flagged car is never called a buying opportunity, even if
  its asking price is far below market — the UI shows a red condition badge
  ("Unfall", "Batterie defekt", "nicht fahrbereit") and a caveat instead.

Impact: the cars that look most underpriced (30-45% below market) are
overwhelmingly accident, battery-defect, or salvage cars — exactly the traps this
layer catches. Clean-only training also nudged accuracy up (84% of clean cars
within ±10%, from 82%).

## Regional price adjustment

The same car sells for measurably different prices across Germany (trade press
documents 10-20% spreads between metro/south and north/east for premium cars).
Every search listing carries a zip code, so the engine learns a per-PLZ-zone
adjustment (first zip digit, 10 zones): after the base fit, each zone's median
log-residual — shrunk toward 0 by sample size (n/(n+15)) so thin zones stay
conservative — becomes its local premium/discount, applied at prediction time.
For the current Tesla data the learned adjustments are small (about −2% around
Hamburg to +2% around Berlin) but real: cross-validation median error improved
from 4.7% to 4.5%. Cars without a zip get the unadjusted national estimate; the
UI shows the applied adjustment ("Region +2%") next to the market band.

## Price-drop tracking (motivated sellers)

`pricing/price_history.js` records each listing's asking price over time in
`data/price_history.json` — one dated entry whenever the price changes.
`train.js` observes prices on every run; `value_newest.js` additionally
refreshes re-seen ads so a cut on a still-listed car is caught. A seller cutting
the price is the classic motivated-seller signal, and no mobile.de tool surfaces
it to buyers today. The UI shows a "Preis ↓ x%" badge (with cut count), the
previous price and last-cut date on the card, a "Preissenkung zuerst" sort and a
drop counter in the stats row. Also derived from the same data: `daysOnMarket`
(days since we first observed the listing — a lower bound on its listing age,
shown as "seit ≥N Tg. beobachtet").

## Holding-cost-aware buy target (Standtage)

A car that stands 95 days (the current national average) before reselling costs
real money — capital, space, care. The standard dealer formula subtracts that
from the buy price, so the engine does too: `valuate(model, ad, margin,
{holdingDays, dailyCost})` computes `maxBuy = market/(1+margin) −
holdingDays·dailyCost` (never below 0, defaults 0/0 so existing behavior is
unchanged). The dashboard has Standtage × €/Tag inputs, recomputes live like
the margin slider, and the suggested offer in the send dialog uses the same
holding-adjusted target. Default is 95 days × €10 — except when a calibration
offer exists: the implied margin derived from a real offer already covers the
dealer's holding cost, so Standkosten then default to 0 to avoid double-counting.

## German market vs imports

mobile.de returns EU-wide inventory, and foreign listings run 3-12% cheaper than
German ones. A German dealer cares about German *resale* value, so the model is
trained on **German listings only**. Every car — including cheaper foreign ones —
is then valued against that German benchmark, which is exactly why foreign
bargains surface as import opportunities (buy abroad, sell in Germany). Imports
are flagged so the dealer can weigh transport/registration cost.

## Margin and deal logic

- `marketPrice` — estimated German resale value.
- `maxBuyPrice = marketPrice / (1 + margin)` — pay at most this to still make the
  target margin when reselling at market. Recomputed live in the UI from the
  slider, so no retraining is needed to explore margins.
- `isDeal` — asking ≤ maxBuyPrice **and** the valuation is in-range.
- `deltaPct` — how far the asking price sits above/below our market estimate.

## Calibration to a real dealer offer

`calibration.json` (gitignored; copy `calibration.example.json`) holds a real
purchase offer the dealer made (`benchmarkId` + `dealerOffer`). At train time the engine values that car and derives the dealer's
**implied margin** = (market − offer) / offer, which becomes the default margin
in the UI and the default price in every offer.

Worked reference: for a 2019 Model 3 Performance with 157,000 km (market €21,937),
a dealer offered €15,600, which is 71% of market and an implied margin of **41%**.
So the tool defaults to a 41% target, and its suggested offers match how that
dealer actually buys. The dashboard shows this benchmark as a banner. Replace the
`benchmarkId`/`dealerOffer` with more offers to re-calibrate.

## Validation (`npm run evaluate`)

Three independent checks, all currently passing:

1. **10-fold cross-validation** (no data leakage): predicted market price vs
   actual asking price.
   - median absolute error **3.4%**, 88% of cars within ±10% (Oct 2026, 1,113
     labeled-clean German listings).
   - Model Y 2.7%, Model 3 3.3%, Model X 4.6%, Model S 6.4%. Before the
     October model work (features, comparables, boosted trees; see
     `pricing/lab/REPORT.md`) it was 4.2% overall and 9.7% on Model S.
2. **Alignment with mobile.de's own price rating** (fully independent ground
   truth). Our delta vs market rises monotonically across their buckets:
   "Sehr guter Preis" −7.5% → "Guter Preis" −1.6% → "Fairer Preis" +3.5% →
   "Erhöhter Preis" +6.5% → "Hoher Preis" +12.7%. The engine agrees with
   mobile.de's ordering without ever seeing it.
3. **Unit tests** (`npm test`, 39 checks): parsing/edge cases, economic
   monotonicity (older→cheaper, more km→cheaper, Model X > Model 3), margin math,
   deal flags, sparse-model fallback, market-tracking (shift all prices 10%,
   valuations scale to 0.90), regional adjustment (learns a synthetic zone gap,
   robust to outliers, no-zip fallback), holding-cost math, and the price-history
   tracker.

## Listing recency ("when did it go live")

mobile.de does not expose an absolute go-live date anywhere in the accessible
data (only the dealer's join date). Two honest signals are used instead:

- **mobile.de's own newest-first ordering** (`sb=age`): `value_newest.js` fetches
  in that order and records each car's `listedRank` (0 = most recently listed).
- **First-seen tracking** (`first_seen.js`): every scrape stamps the date we
  first observed each id. On repeat runs, genuinely new ids are flagged (`NEU`
  in the UI) — a real "new since you last checked" signal for daily monitoring.

## Automated offers (`send_offer.js`)

Sends a templated purchase offer to a listing's seller through the dealer's
mobile.de login, with the engine's suggested price filled in.

- **Safety**: dry-run by default — fills the whole contact form and screenshots
  it but does **not** submit. Real send only with `SEND=1` (CLI) or the "Wirklich
  senden" checkbox in the UI. Nothing goes out without that explicit opt-in.
- **Login**: one-time `LOGIN=1 node pricing/send_offer.js` opens mobile.de to log
  in; the session persists in `profiles/mobile-session` so later offers send from
  the dealer's account.
- **Template**: `dealer.config.json` (copy from `dealer.config.example.json`)
  holds the dealer's contact details and message template with `{title}`,
  `{trim}`, `{year}`, `{mileage}`, `{offer}`, `{market}` placeholders.
- The dashboard "Angebot senden" button posts to a small endpoint in `serve.js`
  that runs this script, so offers can be sent straight from the UI.

## Dealer's own inventory (`scrape_dealer.js`)

Scrapes a dealer's live inventory from their website (`DEALER_URL=...`) and
values each car against the engine (`web/dealer.json`, "Eigener Bestand" tab).
Useful as a sanity check: for the dealer it was built against, asking prices
landed within ~1-4% of the engine's market estimate.

## Files

- `pricing/features.js` — feature extraction + `classifyTrim` (both listing and detail shapes)
- `pricing/price_history.js` — per-listing asking-price history → data/price_history.json
- `pricing/label.js` — AI labeling pass (trim/damage/flags) → data/labels.json
- `pricing/engine.js` — train / predict / valuate (dependency-free linear algebra)
- `pricing/train.js` — build `model.json` + `web/valuations.json` from the scrape
- `pricing/value_newest.js` — fetch freshest listings, value them → `web/newest.json`
- `pricing/scrape_dealer.js` — scrape + value the dealer's own inventory → `web/dealer.json`
- `pricing/send_offer.js` — send a templated offer to a listing (dry-run by default)
- `pricing/first_seen.js` — track first-observed date per listing
- `pricing/evaluate.js` — cross-validation + rating-alignment harness
- `pricing/engine.test.js` — unit tests
- `pricing/load_ads.js` — merge mobile.de + AutoScout24, de-duplicate, training filter
- `pricing/gbm.js` — dependency-free boosted trees (Huber loss, monotone constraints)
- `pricing/lab/` — experiment harness, holdout, REPORT.md
- `src/scrape_autoscout.js` — AutoScout24 scraper mapped to the mobile.de ad shape
- `web/index.html` + `web/serve.js` — Kurswert dashboard + send-offer endpoint

## Limitations

- Structured fields only: an accident history or heavy interior wear that isn't
  in the attributes will make a genuinely cheap car look like a deal. The engine
  surfaces candidates; the dealer still inspects. (The `details.csv` free-text
  description and equipment list are a natural next signal to fold in.)
- Confidence is `low` for pooled/extrapolated valuations — treat those as leads,
  not verdicts.
- Trained on ~1100 German Teslas from one scrape; re-scrape periodically to track
  the market.
