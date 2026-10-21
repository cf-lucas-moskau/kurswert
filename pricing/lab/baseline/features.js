// Feature extraction from a mobile.de ad (search-listing or detail shape).
// Kept separate so the engine, trainer and tests all featurize identically.

const REFERENCE_DATE = 2026 + 9.5 / 12; // late Oct 2026 (Oct scrape); the "now" all ages are measured against

// "07/2019" -> decimal year 2019.5. Returns null on anything implausible so
// the caller can drop the row instead of trusting a garbage age.
function parseRegDate(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const month = +m[1];
  const year = +m[2];
  if (year < 2008 || year > 2027 || month < 1 || month > 12) return null; // Tesla deliveries started ~2008
  return year + (month - 1) / 12;
}

function parseKm(s) {
  const m = (s || '').replace(/[.\s]/g, '').match(/(\d+)/);
  if (!m) return null;
  const km = +m[1];
  return km >= 0 && km < 800000 ? km : null;
}

function parseKw(s) {
  const m = (s || '').match(/(\d+)\s*kW/);
  if (!m) return null;
  const kw = +m[1];
  return kw > 20 && kw < 800 ? kw : null;
}

// Detail ads store attributes as a label/value list; search ads use attr codes.
// Normalize both to the same small set of raw strings.
function rawFields(ad) {
  if (ad.attr) {
    return { reg: ad.attr.fr, km: ad.attr.ml, kw: ad.attr.pw, country: ad.attr.cn, zip: ad.attr.z, title: `${ad.shortTitle || ''} ${ad.subTitle || ''}` };
  }
  const byTag = {};
  for (const a of ad.attributes || []) byTag[a.tag] = a.value;
  return {
    reg: byTag.firstRegistration,
    km: byTag.mileage,
    kw: byTag.power,
    country: ad.contactInfo?.country,
    // detail pages carry the address as "DE-85662 Hohenbrunn ..." in address2
    zip: (ad.contactInfo?.address2 || '').match(/\b(\d{5})\b/)?.[1],
    title: `${ad.shortTitle || ''} ${ad.subTitle || ''} ${byTag.trimLine || ''}`,
  };
}

// Tesla trim is the single biggest value differentiator, so we classify it
// explicitly rather than lean on power alone.
//   Model 3 / Y: Standard Range, Standard Range Plus, Long Range, Performance
//   Model S / X: battery tiers (75/85/90/100, D = dual-motor AWD),
//                Performance (P.. / Ludicrous), Plaid (top), Long Range (newer naming)
// Returns { label (for display), awd, performance, plaid, longRange } from the title.
function classifyTrim(model, title) {
  const t = ` ${(title || '').toLowerCase()} `;
  const has = (re) => re.test(t);

  const plaid = has(/plaid/);
  const performance = plaid || has(/performance|ludicrous|\bp\d{2,3}\b|\bperf\b/);
  const longRange = has(/long.?range|maximale reichweite|gro(ß|ss)er akku|\blr\b|dual motor|dual awd/);
  const srPlus = has(/standard range plus|\bsr\s*\+|standard plus/);
  const srBase = has(/standard range|\bsr\b|\brwd\b|hinterrad|hinterradantrieb/);
  // AWD: dual motor, allrad, or the "D" battery suffix on S/X (75D, 90D, 100D)
  const awd = performance || longRange || has(/allrad|\bawd\b|4wd|dual|\b\d{2,3}\s*d\b|\bxd\b/);

  const is3Y = model === 'Model 3' || model === 'Model Y';
  let label;
  if (is3Y) {
    label = performance ? 'Performance'
      : longRange ? 'Long Range'
      : srPlus ? 'Standard Range Plus'
      : srBase ? 'Standard Range'
      : 'Standard';
  } else {
    // Model S / X: prefer the strongest signal, then battery tier
    const batt = (t.match(/\b(100|90|85|75|70|60)\s*d?\b/) || [])[1];
    label = plaid ? 'Plaid'
      : performance ? 'Performance'
      : batt ? `${batt}${awd ? 'D' : ''}`
      : longRange ? 'Long Range'
      : 'Standard';
  }
  return { label, awd: awd ? 1 : 0, performance: performance ? 1 : 0, plaid: plaid ? 1 : 0, longRange: longRange ? 1 : 0 };
}

// Maps an AI label's trueTrim (or any trim string) back to the model feature
// flags, so a corrected trim drives the regression the same way a parsed one does.
function flagsFromTrim(model, trimStr) {
  return classifyTrim(model, trimStr || '');
}

// The seller's title sometimes contradicts the structured fields: imports carry
// the German re-registration date as EZ ("Zulassung 2023, BJ 04.2016"), and kW
// gets mistyped (244 kW on a 670 PS car). These return the title's value only
// when it is clearly the truth, else null.
const KW_PER_PS = 0.7355;
// German papers list rated power, typically 30-35% below Tesla's marketed peak
// PS, so only a gap beyond that is a data error rather than the usual spread
const POWER_GAP_OVERRIDE = 0.4;

function titleBuildYear(title, reg) {
  const m = (title || '').match(/\b(?:bj|baujahr)\.?\s*:?\s*(?:(\d{1,2})[./])?((?:20)\d{2})\b/i);
  if (!m) return null;
  const year = +m[2] + (m[1] && +m[1] >= 1 && +m[1] <= 12 ? (+m[1] - 1) / 12 : 0);
  return year >= 2008 && year < reg - 0.5 ? year : null;
}

function titlePowerKw(title, kw) {
  const m = (title || '').match(/\b(\d{3,4})\s*ps\b/i);
  if (!m) return null;
  const titleKw = Math.round(+m[1] * KW_PER_PS);
  return titleKw > 20 && titleKw < 800 && (titleKw - kw) / titleKw > POWER_GAP_OVERRIDE ? titleKw : null;
}

// Returns a feature object, or null if the ad lacks the minimum needed to value it.
// `corrections` lists fields overridden from the title ('baujahr', 'leistung').
// `label` (optional) is the AI label for this car (data/labels.json); when present,
// its trueTrim overrides the title-parsed trim.
function featurize(ad, referenceDate = REFERENCE_DATE, label = null) {
  const f = rawFields(ad);
  let reg = parseRegDate(f.reg);
  const km = parseKm(f.km);
  let kw = parseKw(f.kw);
  const price = ad.price?.grossAmount ?? null;
  if (reg == null || km == null || kw == null) return null;
  const corrections = [];
  const built = titleBuildYear(f.title, reg);
  if (built != null) { reg = built; corrections.push('baujahr'); }
  const titleKw = titlePowerKw(f.title, kw);
  if (titleKw != null) { kw = titleKw; corrections.push('leistung'); }

  const ageYears = Math.max(0, referenceDate - reg);
  const model = ad.model || ad.modelKey || 'Andere';
  // prefer the AI-corrected trim when available; fall back to title parsing
  const trim = label?.trueTrim ? flagsFromTrim(model, label.trueTrim) : classifyTrim(model, f.title);
  if (label?.trueTrim) trim.label = label.trueTrim;

  return {
    id: ad.id,
    model,
    price,
    country: f.country || null,
    // first PLZ digit = coarse region (0-9); drives the regional price adjustment.
    // DE only — foreign 5-digit codes (Milan 20121...) must not get German zone premiums
    plzZone: f.country === 'DE' && /^\d{5}/.test(f.zip || '') ? f.zip[0] : null,
    ageYears,
    mileageKm: km,
    powerKw: kw,
    trimLabel: trim.label,
    awd: trim.awd,
    performance: trim.performance,
    plaid: trim.plaid,
    longRange: trim.longRange,
    corrections,
    regYear: Math.floor(reg), // after any title correction
  };
}

module.exports = { featurize, classifyTrim, parseRegDate, parseKm, parseKw, REFERENCE_DATE };
