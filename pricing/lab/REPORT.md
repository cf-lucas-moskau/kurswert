# Pricing lab: measuring and improving the Tesla price engine

Run 2026-10-21 by a background agent; everything lives in `pricing/lab/`. The
proposal was merged into `engine.js` / `features.js` / `gbm.js` the same day,
with three changes on top: a listing is never its own comparable, AutoScout24
listings are excluded from training, and training prices are bounded to
2,000-200,000 EUR (`makeTrainingFilter` in `pricing/load_ads.js`).

## In plain language

We measured how close the engine's market price lands to what sellers ask, on
cars it had not seen while learning. Before: typically 4.2% off. Three changes
bring that to about 3.4% in cross-validation and 3.8% on a final set of cars
locked away until the end: (1) the engine now reads things sellers state that
it ignored (battery size, Model 3 Highland / Model Y Juniper / S-X refresh
generation, free lifetime Supercharging, FSD, seven seats, number of owners,
fresh TÜV, private vs dealer); (2) each estimate is nudged toward the 15 most
similar cars on the market; (3) a second model (boosted trees) is blended in,
which handles the irregular Model S/X prices well. Model S and X gain most:
typical miss from ~9% to under 6% in cross-validation. The price band still
contains the asking price for about two out of three cars, as intended.

## Setup

- Frozen inputs in `snapshot/` (gitignored): `raw_ads.json` (1,635 ads),
  `labels.json`, later `raw_ads_as24.json`. `baseline/` holds the engine as it
  was at the start.
- Universe: train.js filter (German, featurizable, price > 0, not labeled
  damaged/battery issue): 1,177 listings.
- Grouped splits: near-duplicates (same model + first reg + exact km + power)
  always stay together. `CV_GROUP=seller` holds out whole dealers.
- Holdout: 15% of groups (175 listings, seed 20261021), scored once at the end.
- CV: 5 x 10-fold grouped CV on the remaining 1,002 (seeds 11..55); repeat
  spread of median APE ~0.05pp.
- No leaked features: no priceRating / thresholds / offsets, no price
  derivatives, no id order.

```
node pricing/lab/harness.js                       # all candidates, 5x10 CV
node pricing/lab/harness.js baseline proposed
CV_GROUP=seller node pricing/lab/harness.js baseline proposed
node pricing/lab/harness.js --holdout baseline proposed
node pricing/lab/holdout_bootstrap.js baseline proposed
```

## Baseline

5x10 grouped CV: median APE 4.16%, mean 6.4%, ±5% 58%, ±10% 82%, bias +0.2%,
band coverage 68%. Per model: 3 3.9, Y 3.0, S 9.4, X 7.4.

## Experiments (5x10 grouped CV, %)

| candidate | med | mean | ±5 | ±10 | bias | cover | 3 | Y | S | X |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 4.16 | 6.4 | 58 | 82 | 0.2 | 68 | 3.9 | 3.0 | 9.4 | 7.4 |
| r1 +SR/SR+ flags, trim regex fixes | 4.12 | 6.4 | 58 | 82 | 0.2 | 66 | 3.9 | 3.0 | 9.2 | 7.4 |
| r2 +generations (Highland/Juniper/S-X refresh) | 4.00 | 6.2 | 60 | 84 | 0.1 | 65 | 3.7 | 2.9 | 7.9 | 6.6 |
| r3 +battery kWh (+missing flag) | 3.85 | 6.1 | 61 | 84 | 0.1 | 64 | 3.6 | 2.9 | 7.8 | 6.5 |
| r4 +free Supercharging, FSD, 7 seats | 3.74 | 5.8 | 62 | 85 | 0.1 | 64 | 3.6 | 2.9 | 7.3 | 6.5 |
| r5 r4 + EAP, HW3/4, tow hitch | 3.78 | 5.9 | 62 | 85 | 0.2 | 64 | 3.6 | 2.9 | 7.9 | 6.6 |
| r6 r4 + private, #owners, HU new (best_ridge) | 3.68 | 5.8 | 62 | 86 | 0.1 | 64 | 3.5 | 2.8 | 6.5 | 6.7 |
| r7 r4 + age x km | 3.73 | 5.9 | 62 | 85 | 0.1 | 65 | 3.5 | 2.8 | 7.5 | 6.5 |
| r12 r6 + S/X interactions | 3.65 | 5.8 | 63 | 86 | 0.1 | 63 | 3.5 | 2.9 | 6.1 | 6.9 |
| r13 r6 + kW², log km | 3.73 | 5.8 | 61 | 85 | 0.1 | 62 | 3.5 | 2.9 | 7.0 | 6.9 |
| r8 Huber IRLS instead of 2.5σ drop | 3.78 | 6.0 | 62 | 86 | 0.0 | 59 | 3.6 | 2.8 | 6.4 | 6.7 |
| r8b no outlier handling | 3.87 | 6.1 | 60 | 84 | 0.3 | 74 | 3.6 | 2.9 | 8.1 | 7.2 |
| r9 λ=0.3 / 3 / 10 | 3.69 / 3.78 / 3.98 | | | | | | | | | |
| r10 no PLZ adjustment | 3.75 | 5.8 | 61 | 86 | 0.0 | 63 | 3.5 | 3.0 | 6.9 | 6.5 |
| r11 single pooled linear fit | 4.14 | 6.1 | 59 | 85 | 0.2 | 71 | 3.9 | 3.5 | 6.9 | 6.1 |
| a1 + clean foreign mobile.de ads, offset flag | 3.75 | 6.0 | 61 | 85 | 0.2 | 67 | 3.7 | 2.7 | 7.0 | 6.0 |
| g1/g2/g3 least-squares boosted trees | 4.25 / 4.15 / 4.39 | | | | | | | | | |
| g4 Huber trees δ=.08 400 x d4 | 3.80 | 6.1 | 61 | 86 | 0.1 | 70 | 3.6 | 3.0 | 6.3 | 5.9 |
| g5 Huber 800 x d4 colsample .7 | 3.74 | 6.0 | 62 | 86 | 0.1 | 71 | 3.6 | 3.0 | 6.3 | 5.5 |
| g7 Huber δ=.04 | 4.19 | 6.9 | 57 | 81 | -0.3 | 75 | 3.7 | 3.1 | 10.5 | 9.1 |
| k1 ridge + 15-NN comps correction | 3.55 | 5.6 | 63 | 87 | -0.2 | 65 | 3.4 | 2.7 | 6.3 | 6.7 |
| k2 k=8 / k3 k=30 | 3.56 / 3.55 | | | | | | | | | |
| h1 trees boosted on ridge residuals | 3.52 | 5.6 | 63 | 87 | -0.1 | 65 | 3.4 | 2.8 | 5.6 | 6.3 |
| e2 0.7 ridge + 0.3 trees | 3.50 | 5.6 | 64 | 86 | 0.1 | 69 | 3.5 | 2.9 | 5.8 | 5.8 |
| e3 0.7 (ridge+comps) + 0.3 trees | 3.42 | 5.5 | 65 | 87 | -0.1 | 70 | 3.3 | 2.7 | 5.5 | 5.8 |
| e4 0.5/0.5 | 3.49 | 5.6 | 65 | 88 | 0.0 | 71 | 3.4 | 2.7 | 5.6 | 5.5 |
| **proposed** (e3 in engine.js) | **3.40** | **5.4** | **65** | **87** | **0.0** | **72** | **3.3** | **2.7** | **5.6** | **5.7** |
| as1 best_ridge + German AS24, source flag | 3.65 | 5.6 | 63 | 85 | 0.1 | 67 | 3.5 | 2.8 | 7.1 | 5.5 |
| as4 + all-country AS24 | 4.08 | 6.1 | 59 | 84 | 0.3 | 77 | 4.3 | 3.1 | 7.0 | 5.4 |
| as5 proposed + German AS24 | 3.44 | 5.3 | 65 | 88 | 0.1 | 76 | 3.3 | 2.7 | 6.2 | 5.6 |

Did not help: EAP/HW3/tow-hitch tokens, interaction and shape terms, Huber IRLS
in the linear fit, stronger ridge, one pooled linear model, foreign listings,
least-squares trees, AutoScout24 data. The PLZ adjustment still earns ~0.07pp.

Seller-grouped CV: baseline 4.41 -> best_ridge 4.00 -> ridge+comps 3.88 ->
proposed 3.77 (S 11.6 -> 7.7, X 8.8 -> 8.3). With AS24: as1 4.03, as5 3.89.

## Holdout (winner fixed before scoring)

| | median APE | mean APE | ±5% | ±10% | bias | coverage |
|---|---|---|---|---|---|---|
| baseline | 4.20% | 7.55% | 57% | 81% | 0.0% | 66% |
| proposed | 3.80% | 6.57% | 63% | 83% | -0.3% | 68% |

Per model (median / mean APE): 3 (n=65) 3.23/6.54 -> 3.83/6.44; Y (64)
3.04/4.12 -> 3.02/3.83; S (24) 10.58/16.25 -> 10.96/12.55; X (22) 6.59/11.05
-> 7.34/8.41.

Paired bootstrap (2,000 resamples): overall Δmean APE CI [-1.71, -0.29]pp,
Δmedian CI [-1.00, +0.43]pp; proposed closer on 96/175 cars (17/24 Model S).
The holdout confirms the direction but its median gain (0.4pp) is smaller than
CV's (0.76pp) and not significant at n=175 on its own; Model 3 is flat there.

## What was merged

1. `features.js`: battery, seats, owners, HU, seller type from both ad shapes;
   trim regex fixes (P100DL, P 90 D, Peformance, M3P/MYP, S75D, Dualmotor,
   Rear-Wheel); `batteryKwh()`; generation, free-Supercharging, FSD, seven-seat,
   private-seller, owners and HU-new features.
2. `engine.js`: extended design rows (battery/owners continuous with missing
   flags); per-model comps table, prediction adds the mean clipped (±0.15)
   residual of the 15 nearest comps shrunk 15/25, never using the listing
   itself; 400 depth-4 Huber trees from `gbm.js`, monotone in age and km,
   blended 70/30 in log space for Model 3/Y/S/X (band sigma blended the same
   way); region adjustment after the blend. `model.json` ~5 KB -> ~200 KB.
3. Tests: trim regexes, battery precedence, new features and nulls, JSON
   round-trip, monotone mileage sweep, free-Supercharging effect, comps clip,
   no self-comparable.

## Data findings

- A 460,000 EUR Model 3 SR+ and a 499,000 EUR Plaid Signature (50 km) were in
  the clean training set (now filtered).
- At run time only 45 of 700 labels matched current ad ids, so the clean-comps
  filter was nearly inactive (labeling of the current scrape is under way).
- Sellers 455119 and 45364575 cross-post identical cars; an Italian dealer
  posts the same car five times; seller 467115 holds 110 of 1,183 German ads.
- 81 of 289 German S/X were parsed as "Standard" trim by the old parser.
- Free Supercharging ~+15% on old S/X; Highland Model 3 was under-priced ~9%;
  S/X without a battery field ask ~6% less than predicted.
- Roadster and Cybertruck (7 listings) stay 25-60% off: too few comps.
- AutoScout24: 4,071 ads, 946 cross-posts, 236 German non-cross-posts. Price
  level matches mobile.de (cross-post median gap 0%), but its power figures run
  lower (median Model Y 258 vs 313 kW) and it lacks battery/owners/HU/seats.
  Adding it did not improve German mobile.de prediction; normalise power first.
