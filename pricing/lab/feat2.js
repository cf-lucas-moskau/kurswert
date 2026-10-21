// Extended feature extraction. Everything here is something an owner can fill
// in for their own car (or that a listing title states); no mobile.de price
// rating, no price derivatives, no id order.
const { REFERENCE_DATE } = require('./baseline/features');

const lower = (s) => ` ${(s || '').toLowerCase()} `;

// battery capacity in kWh: structured field first, then title text
function batteryKwh(ad, model) {
  const bc = (ad.attr?.bc || '').match(/(\d{2,3})\s*kWh/);
  if (bc) return +bc[1];
  const t = lower(`${ad.shortTitle} ${ad.subTitle}`);
  const kwh = t.match(/(\d{2,3})\s*kwh/);
  if (kwh && +kwh[1] >= 50 && +kwh[1] <= 125) return +kwh[1];
  if (model === 'Model S' || model === 'Model X') {
    const m = t.match(/(?:\b|[sx]|p)(100|90|85|75|70|60)\s*d?l?\b/);
    if (m) return +m[1];
  }
  return null;
}

function trim(model, ad) {
  const t = lower(`${ad.subTitle} ${ad.shortTitle}`);
  const has = (re) => re.test(t);
  const plaid = has(/plaid/);
  const perf = plaid || has(/performance|peformance|ludicrous|\bp\s?\d{2,3}\s?d?l?\b|\bperf\b|\bm3p\b|\bmyp\b/);
  const lr = has(/long.?range|maximale reichweite|gro(ß|ss)er akku|\blr\b|dual motor|dual awd|dualmotor/);
  const srp = has(/standard range plus|\bsr\s*\+|standard plus|\bsr\+/);
  const sr = has(/standard range|\bsr\b|\brwd\b|hinterrad|rear.?wheel/);
  const awd = perf || lr || has(/allrad|\bawd\b|4wd|dual|\b\d{2,3}\s*d\b|\bxd\b|[sx]\d{2,3}d\b/);
  return { plaid: +plaid, perf: +perf, lr: +lr, srp: +srp, sr: +sr, awd: +awd };
}

function extra(r) {
  const { ad, f } = r;
  const model = f.model;
  const t = lower(`${ad.shortTitle} ${ad.subTitle}`);
  const reg = REFERENCE_DATE - f.ageYears;
  const tr = trim(model, ad);
  // when an AI label corrected the trim, trust it over the regexes
  if (r.label?.trueTrim) Object.assign(tr, trim(model, { subTitle: r.label.trueTrim, shortTitle: '' }));
  const batt = batteryKwh(ad, model);
  const seats = +(ad.attr?.sc || 0);
  const weight = +((ad.attr?.nw || '').replace(/[^\d]/g, '')) || null;
  return {
    model,
    age: f.ageYears,
    km: f.mileageKm / 100000,
    kw: f.powerKw / 100,
    reg,
    ...tr,
    batt, // may be null
    // generations: Model 3 "Highland" EU deliveries from ~10/2023, Model Y
    // "Juniper" from ~03/2025, S/X refresh (Plaid / new interior) from ~2021
    highland: +(model === 'Model 3' && (reg >= 2023.75 || /highland/.test(t))),
    juniper: +(model === 'Model Y' && (reg >= 2025.17 || /juniper/.test(t))),
    refresh: +((model === 'Model S' || model === 'Model X') && reg >= 2021.3),
    freeSC: +/sc01|free\s*(super)?charg|freies?\s*(super)?(laden|charg)|kostenlos\w*\s*(super)?(laden|charg)|\bfusc\b|lifetime|supercharger.?free|free.?supercharg|frei(es)? (super)?charg|supercharging frei/.test(t),
    fsd: +/\bfsd\b|full self|\bfsd\b|autonomes fahren/.test(t),
    eap: +/\beap\b|enhanced autopilot|erweiterte[rs]? autopilot/.test(t),
    hw: +/hw\s*[34]|ki.?computer|ai\s?4|autopilot\s*3|\bap\s*3/.test(t),
    seats7: +(seats >= 6 || /7[\s-]*sitz|7[\s-]*seat|6[\s-]*sitz/.test(t)),
    ahk: +/\bahk\b|anh(ä|a)ngerkupplung|tow|trailer/.test(t),
    private: +(ad.contactInfo?.sellerType === 'PRIVATE'),
    owners: ad.attr?.pvo != null ? Math.min(+ad.attr.pvo, 4) : null,
    huNew: +(ad.attr?.gi === 'Neu'),
    weight,
    plzZone: f.plzZone,
    foreign: +(f.country !== 'DE'),
    source: ad.source || 'mobile.de',
  };
}

module.exports = { extra, batteryKwh, trim };
