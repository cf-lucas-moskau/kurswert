// Which Tesla a listing really is: model plus trim (the variant a buyer filters
// by), from every field a listing offers. Pure: classify(facts) has no I/O.
//
//   factsFromListing(ad, detail, label) -> facts   (the boundary: any source)
//   classify(facts) -> { model, trim, label, batteryKwh, confidence, rule }
//
// Rules run in order and the first that answers wins, so `rule` names exactly
// what decided. Text the seller wrote (title, variant, trim line, model range)
// comes first; then the AI label's trueTrim, which read the description; then
// battery, drive, power and first registration. Nothing fires -> trim
// 'unbekannt' with confidence 'keine'. A rule never guesses between two
// trims: power values are only used where the scraped data shows one trim.
//
// Confidence: 'hoch' = the listing names the trim; 'mittel' = inferred from
// the AI label or from specs; 'keine' = unknown.

const UNKNOWN = 'unbekannt';
const MODELS = ['Model 3', 'Model Y', 'Model S', 'Model X', 'Cybertruck', 'Roadster'];

// Trims per model, in the order the dashboard shows them.
const TRIMS = {
  'Model 3': ['Standard', 'RWD', 'Long Range RWD', 'Long Range AWD', 'Performance'],
  'Model Y': ['Standard', 'RWD', 'Long Range RWD', 'Long Range AWD', 'Performance'],
  'Model S': ['60', '70', '75', '85', '90', '100', 'Raven Standard Range', 'Raven Long Range', 'Raven Performance', 'Long Range', 'Plaid'],
  'Model X': ['60', '70', '75', '90', '100', 'Raven Standard Range', 'Raven Long Range', 'Raven Performance', 'Long Range', 'Plaid'],
  Cybertruck: ['AWD', 'Cyberbeast'],
  Roadster: ['1.5', '2.0', '2.5'],
};

// EU dates as decimal years: the 2025 'Standard' 3/Y, the Raven S/X
// (Long Range / Performance replace the battery badges), the refreshed S/X
// (Plaid, new interior; registrations from mid 2021 are refresh imports)
const STANDARD_FROM = 2025.75;
const RAVEN_FROM = 2019.25;
const REFRESH_FROM = 2021.5;
// before this, a 3/Y driving the rear wheels only is a Standard Range / RWD;
// then Tesla also sold a Long Range RWD (Model 3 from spring 2023, Model Y 2024)
const LR_RWD_FROM = { 'Model 3': 2023.25, 'Model Y': 2024 };

// German papers list several power figures (peak, 30-minute), so one trim
// shows up under several kW values, and the Long Range RWD reuses RWD and
// Long Range figures. Per era (before / since LR_RWD_FROM), only values where
// at least 92% of 5+ listings that name their trim name this one are kept.
// Measured on the Oct 2026 scrape; `node pricing/trim_report.js --power`
// re-derives them.
const POWER_TRIM = {
  'Model 3': {
    before: {
      RWD: [88, 100, 175, 202, 208, 209, 220, 225, 239, 283, 287],
      'Long Range AWD': [153, 254, 258, 324, 350, 366],
      Performance: [155, 377],
    },
    since: {
      RWD: [88, 175, 188, 202, 239],
      'Long Range AWD': [153, 324, 366],
      Performance: [338, 375, 377, 393, 461],
    },
  },
  'Model Y': {
    before: {
      RWD: [88, 175, 188, 204, 220, 221, 235, 255],
      'Long Range AWD': [153, 158, 190, 258, 259, 274, 286, 324, 351, 378],
      Performance: [185, 340, 353, 392, 393],
    },
    since: {
      RWD: [88, 175],
      'Long Range AWD': [378],
      Performance: [393],
    },
  },
};
const S_X_BATTERIES = [60, 70, 75, 85, 90, 100];

const RE = {
  plaid: /plaid/,
  raven: /raven/,
  cyberbeast: /cyberbeast/,
  ludicrous: /ludicrous/,
  // "Long Range ... Performance Upgrade" is a Long Range with the acceleration
  // boost, not a Performance; wheels or brakes "im Performance-Look" neither
  notPerformance: /(acceleration|beschleunigungs)[\s-]*(boost|upgrade)|performance[\s-]*(upgrade|felgen|räder|raeder|wheels|look|optik|paket|bremse\w*|spoiler|sitze|interieur|interior|carbon)/,
  performance: /perform(a|en|\b)|peformance|perfomance|\bperf\b|\bm3p\b|\bmyp\b/,
  longRange: /lon[gd]e?[\s.-]*range|langstr|\blr\b|max(imale|\.)?\s*reichweite|grande autonomie|gran autonom[ií]a|grande autonomia|groot bereik|lange afstand|gro(ss|ß)e[rn]? (akku|batterie)|extended range/,
  standardRange: /standard[\s-]*(range|reichweite|plus|\+)|\bsr\s*\+|\bsrp\b|\bsr\b|stnd|std\.?\s*range|standart|autonomi[ea] standard|autonom[ií]a est[áa]ndar/,
  standard: /\bstandard\b/,
  // LFP cells (CATL, BYD Blade) only ever went into the rear-drive 3/Y
  lfp: /\blfp\b|blade|\bbyd\b/,
  premium: /\bpremium\b/,
  rwd: /\brwd\b|hinterrad|heckantrieb|rear[\s-]*wheel|propulsion\b|achterwiel|trazione posteriore|(propulsi[óo]n|tracci[óo]n) trasera/,
  awd: /\bawd\b|dual[\s-]*motor|\bdual\b|allrad|4x4|\b4wd\b|int[ée]grale|vierwiel|tracci[óo]n total|trazione integrale/,
  kwh: /(\d{2,3})(?:[.,]\d)?\s*kwh/,
};

// "P90DL", "S 75D", "ModelS85", "85P+", "85 kWh": the S/X battery badge. A
// bare number counts only with a badge letter or kWh, so "100 km" or "90 %"
// never match.
const BADGE = /(?:^|[^a-z0-9]|model)(?:[sx]\s?)?(p\s?)?(60|70|75|85|90|100)\s?(d?)(p?)(l?)(\+?)(?![a-z0-9])/g;
function badge(text) {
  for (const m of text.matchAll(BADGE)) {
    const [, pre, size, d, post, l, plus] = m;
    const p = pre || post;
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 6);
    const lettered = p || d || plus || /^\s?kwh/.test(tail) || /[sx]\s?\d/.test(m[0]);
    if (!lettered || /^\s?(km|tkm|tsd|%|ps|kw\b|zoll|"|')/.test(tail)) continue;
    return { size: +size, label: `${p ? 'P' : ''}${size}${d ? 'D' : ''}${l ? 'L' : ''}${plus ? '+' : ''}` };
  }
  return null;
}

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/\s+/g, ' ')} `;
const textPerformance = (t) => RE.performance.test(t.replace(new RegExp(RE.notPerformance.source, 'g'), ' '));

// ---- Model 3 / Model Y ----------------------------------------------------

const lrRwdExists = (f) => f.reg == null || f.reg >= LR_RWD_FROM[f.model];
function powerTrim(f) {
  if (f.reg == null || f.powerKw == null) return null;
  const table = POWER_TRIM[f.model][lrRwdExists(f) ? 'since' : 'before'];
  return Object.keys(table).find((trim) => table[trim].includes(f.powerKw)) || null;
}

// The trim a seller's wording names, or null. Shared by the listing text and
// the AI label (both are just text).
function threeYFromText(t, f) {
  const lr = RE.longRange.test(t);
  const sr = RE.standardRange.test(t);
  const rwdText = RE.rwd.test(t) && !RE.awd.test(t);
  const byPower = powerTrim(f);
  if (!(lr && RE.notPerformance.test(t)) && textPerformance(t)) {
    // "Long Range AWD Performance" is Tesla's own name for the Performance,
    // but dealers also put it on Long Ranges, and "SR+ 20 Zoll Performance,
    // Carbon" means trim pieces: where wording mixes, the power decides
    if (byPower === 'Performance') return { trim: byPower, why: 'performance' };
    if (lr && byPower === 'Long Range AWD') return { trim: byPower, why: 'long-range+performance-by-power' };
    if ((sr || rwdText) && byPower === 'RWD') return { trim: byPower, why: 'rwd+performance-by-power' };
    if (sr || rwdText || byPower === 'RWD') return null;
    return { trim: 'Performance', why: 'performance' };
  }
  if (lr) {
    const rwdOnly = rwdText || (f.drive === 'RWD' && !RE.awd.test(t));
    return rwdOnly ? { trim: 'Long Range RWD', why: 'long-range+rwd' } : { trim: 'Long Range AWD', why: 'long-range' };
  }
  const newEra = f.reg != null && f.reg >= STANDARD_FROM;
  // from late 2025 the rear-drive car comes as the 'Standard' or the Premium
  if (newEra && RE.premium.test(t) && (rwdText || sr || RE.lfp.test(t))) return { trim: 'RWD', why: 'premium-rwd-2025' };
  if (sr) return newEra ? null : { trim: 'RWD', why: 'standard-range' };
  if (RE.lfp.test(t) && !newEra) return { trim: 'RWD', why: 'lfp-battery' };
  // the words below also show up in equipment lists ("Allrad", "Standard"),
  // so a power figure that names another trim wins over them
  const weak = (trim, why) => (byPower && byPower !== trim ? null : { trim, why });
  if (RE.standard.test(t)) {
    if (newEra) return { trim: 'Standard', why: 'standard-2025' };
    return f.reg == null ? null : weak('RWD', 'standard-before-2025');
  }
  if (rwdText) return newEra ? null : weak('RWD', 'rwd');
  if (RE.awd.test(t) && !RE.rwd.test(t)) return weak('Long Range AWD', 'dual-motor');
  return null;
}

function threeYFromSpecs(f) {
  const old = f.reg != null && f.reg < STANDARD_FROM;
  const kwh = f.batteryKwh;
  if (old && kwh != null && kwh <= 64 && f.drive !== 'AWD') return { trim: 'RWD', why: 'battery<=64kWh' };
  if (f.drive === 'RWD' && !lrRwdExists(f)) return { trim: 'RWD', why: 'rear-drive-before-long-range-rwd' };
  if (f.drive === 'RWD' && old && kwh != null && kwh >= 74) return { trim: 'Long Range RWD', why: 'rear-drive+battery>=74kWh' };
  const trim = powerTrim(f);
  if (!trim) return null;
  // power can't overrule the drive the equipment list states, and the 2025
  // Standard shares the RWD's figures
  if (trim === 'RWD' ? f.drive === 'AWD' || !old : f.drive === 'RWD') return null;
  return { trim, why: `power-${f.powerKw}kW` };
}

// ---- Model S / Model X ----------------------------------------------------

function era(reg) {
  if (reg == null) return null;
  return reg >= REFRESH_FROM ? 'refresh' : reg >= RAVEN_FROM ? 'raven' : 'badge';
}

const batteryTrim = (size, label, why) => ({ trim: String(size), label: label || `${size} kWh`, batteryKwh: size, why });

function sxFromText(t, f) {
  const e = era(f.reg);
  const longRangePower = e === 'refresh' && f.powerKw >= 480 && f.powerKw <= 520;
  if (RE.plaid.test(t)) {
    // "Plaid" also names wheels and seats; the Plaid itself has 750 kW
    return longRangePower ? { trim: 'Long Range', why: 'plaid-word+long-range-power' } : { trim: 'Plaid', why: 'plaid' };
  }
  const perf = textPerformance(t) || RE.ludicrous.test(t);
  // a lettered badge (P90D, 100D) names the car; a bare "100 kWh" on a
  // Raven or refresh car is just its battery and falls through. The refresh
  // has no badges, so one there is a seller's habit, not the car
  const b = e === 'refresh' ? null : badge(t);
  const lettered = b && b.label !== String(b.size);
  if (lettered) {
    // "100D Ludicrous Performance"; only the 85, 90 and 100 came as a P
    const label = perf && b.size >= 85 && !b.label.startsWith('P') ? `P${b.label}` : b.label;
    return batteryTrim(b.size, label, `badge-${b.label}`);
  }
  if (RE.raven.test(t)) return perf ? { trim: 'Raven Performance', why: 'raven+performance' } : { trim: 'Raven Long Range', why: 'raven' };
  if (b && (e === 'badge' || e == null)) {
    const dual = RE.awd.test(t) || f.drive === 'AWD';
    return batteryTrim(b.size, dual ? `${b.size}D` : null, `badge-${b.label}`);
  }
  const lr = RE.longRange.test(t);
  if (lr && e === 'refresh') return { trim: 'Long Range', why: 'long-range-refresh' };
  if (lr && e === 'raven') return { trim: 'Raven Long Range', why: 'long-range-2019-2021' };
  if (perf && e === 'raven') return { trim: 'Raven Performance', why: 'performance-2019-2021' };
  // the short-lived 2019/2020 Standard Range (a software-limited 100 kWh)
  if (RE.standardRange.test(t) && e === 'raven') return { trim: 'Raven Standard Range', why: 'standard-range-2019-2021' };
  // Performance was always named, so an unnamed dual-motor Raven is the Long Range
  if (!perf && e === 'raven' && RE.awd.test(t)) return { trim: 'Raven Long Range', why: 'dual-motor-2019-2021', confidence: 'mittel' };
  // the refresh has no Performance: anything else dual-motor is the Long
  // Range, unless its power is far above the Long Range's ~500 kW
  if (!perf && e === 'refresh' && RE.awd.test(t) && !(f.powerKw > 560)) return { trim: 'Long Range', why: 'dual-motor-refresh' };
  if (perf && e === 'badge') {
    if (f.batteryKwh && S_X_BATTERIES.includes(f.batteryKwh)) {
      return { ...batteryTrim(f.batteryKwh, `P${f.batteryKwh}${f.batteryKwh > 85 ? 'D' : ''}`, 'performance+battery'), confidence: 'mittel' };
    }
    // until early 2015 the only Performance Model S was the P85
    if (f.model === 'Model S' && f.reg < 2015) return { ...batteryTrim(85, 'P85', 'performance-before-2015'), confidence: 'mittel' };
  }
  return null;
}

function sxFromSpecs(f) {
  const e = era(f.reg);
  const kw = f.powerKw;
  if (kw != null && kw >= 700 && f.reg >= 2021) return { trim: 'Plaid', why: `power-${kw}kW` };
  if (e === 'refresh' && kw >= 480 && kw <= 520) return { trim: 'Long Range', why: `power-${kw}kW-refresh` };
  if (e === 'raven' && kw >= 560 && kw <= 620) return { trim: 'Raven Performance', why: `power-${kw}kW-2019-2021` };
  if (e === 'raven' && kw >= 380 && kw <= 425) return { trim: 'Raven Long Range', why: `power-${kw}kW-2019-2021` };
  if (e === 'badge' && S_X_BATTERIES.includes(f.batteryKwh)) return batteryTrim(f.batteryKwh, null, 'battery-field');
  return null;
}

// ---- Cybertruck / Roadster ------------------------------------------------

function cybertruckFromText(t, f) {
  if (RE.cyberbeast.test(t) || (f.powerKw != null && f.powerKw >= 600)) return { trim: 'Cyberbeast', why: 'cyberbeast' };
  if (RE.awd.test(t) || (f.powerKw >= 440 && f.powerKw <= 470)) return { trim: 'AWD', why: 'dual-motor' };
  return null;
}

function roadsterFromText(t, f) {
  const m = t.match(/(?:\bv|\b)(1\.5|2\.0|2\.5)\b/);
  if (m) return { trim: m[1], why: `version-${m[1]}` };
  // the 2.5 replaced the 2.0 in mid 2010; earlier cards overlap 1.5 and 2.0
  return f.reg >= 2011 ? { trim: '2.5', why: 'registered-2011+', confidence: 'mittel' } : null;
}

const FAMILY = {
  'Model 3': { text: threeYFromText, specs: threeYFromSpecs },
  'Model Y': { text: threeYFromText, specs: threeYFromSpecs },
  'Model S': { text: sxFromText, specs: sxFromSpecs },
  'Model X': { text: sxFromText, specs: sxFromSpecs },
  Cybertruck: { text: cybertruckFromText, specs: () => null },
  Roadster: { text: roadsterFromText, specs: () => null },
};

function modelOf(model, text) {
  if (MODELS.includes(model)) return model;
  if (/cyber(truck|beast)/.test(text)) return 'Cybertruck';
  const m = text.match(/model\s?([3ysx])\b/);
  if (m) return `Model ${m[1].toUpperCase()}`;
  return /roadster/.test(text) ? 'Roadster' : UNKNOWN;
}

function displayLabel(model, r, batteryKwh) {
  if (r.label) return r.label;
  if ((model === 'Model 3' || model === 'Model Y') && batteryKwh) return `${r.trim} · ${batteryKwh} kWh`;
  return r.trim;
}

// facts: { model, text, powerKw, reg, batteryKwh, drive: 'AWD'|'RWD'|null, aiTrim }
function classify(facts) {
  const text = norm(facts.text);
  const model = modelOf(facts.model, text);
  const f = { ...facts, model, text };
  const family = FAMILY[model];
  const unknown = (rule) => ({ model, trim: UNKNOWN, label: UNKNOWN, batteryKwh: f.batteryKwh ?? null, confidence: 'keine', rule });
  if (!family) return unknown('model-unknown');
  const steps = [
    ['text', 'hoch', () => family.text(text, f)],
    ['ai-label', 'mittel', () => (f.aiTrim ? family.text(norm(f.aiTrim), f) : null)],
    ['specs', 'mittel', () => family.specs(f)],
  ];
  for (const [source, confidence, run] of steps) {
    const r = run();
    if (!r) continue;
    const batteryKwh = r.batteryKwh ?? f.batteryKwh ?? null;
    // a rule that infers rather than reads can only lower the confidence
    return { model, trim: r.trim, label: displayLabel(model, r, batteryKwh), batteryKwh, confidence: r.confidence || confidence, rule: `${source}:${r.why}` };
  }
  return unknown('no-signal');
}

// ---- boundary: listing (mobile.de search, detail page, AutoScout24) -> facts

const parseKw = (s) => {
  const m = String(s || '').match(/(\d+)\s*kW/);
  return m ? +m[1] : null;
};
const parseReg = (s) => {
  const m = String(s || '').match(/(\d{1,2})\/(\d{4})/);
  return m ? +m[2] + (+m[1] - 1) / 12 : null;
};
const parseKwh = (s) => {
  const m = norm(s).match(RE.kwh);
  return m && +m[1] >= 40 && +m[1] <= 130 ? +m[1] : null;
};

// ad: a search-result listing (mobile.de or AutoScout24); detail: its
// mobile.de detail page, if fetched; label: its AI label, if any. Only a
// high-confidence AI trim is used.
function factsFromListing(ad, detail = null, label = null) {
  const attrs = {};
  for (const a of detail?.attributes || []) attrs[a.tag] = a.value;
  const features = detail?.features || [];
  const text = [ad.shortTitle, ad.subTitle, attrs.trimLine, attrs.modelRange, ad.model === 'Andere' ? detail?.title : null]
    .filter(Boolean).join(' ');
  const drive = features.includes('Allradantrieb') ? 'AWD' : features.includes('Heckantrieb') ? 'RWD' : null;
  return {
    model: ad.model,
    text,
    powerKw: parseKw(ad.attr?.pw || attrs.power),
    reg: parseReg(ad.attr?.fr || attrs.firstRegistration),
    batteryKwh: parseKwh(ad.attr?.bc) ?? parseKwh(attrs.batteryCapacity) ?? parseKwh(text),
    drive,
    aiTrim: label?.trimConfidence === 'high' ? label.trueTrim : null,
  };
}

const classifyListing = (ad, detail, label) => classify(factsFromListing(ad, detail, label));

module.exports = { classify, classifyListing, factsFromListing, TRIMS, UNKNOWN, LR_RWD_FROM };
