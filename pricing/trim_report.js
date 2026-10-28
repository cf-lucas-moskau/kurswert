// How the trim classifier (trim.js) does on the current listings: the trim
// distribution per model, the unknowns with their raw fields, and a random
// sample to check by hand against the listings.
//   node pricing/trim_report.js              # distribution + unknowns
//   node pricing/trim_report.js --sample 40  # plus 40 random listings (seed 1)
//   node pricing/trim_report.js --sample 40 --seed 7
//   node pricing/trim_report.js --power      # kW values that name one 3/Y trim (trim.js POWER_TRIM)
const fs = require('fs');
const { loadAds } = require('./load_ads');
const { dataFile } = require('../src/paths');
const { classify, classifyListing, factsFromListing, TRIMS, UNKNOWN, LR_RWD_FROM } = require('./trim');

const readJson = (name) => (fs.existsSync(dataFile(name)) ? JSON.parse(fs.readFileSync(dataFile(name), 'utf8')) : {});
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? +process.argv[i + 1] : fallback;
};

const { ads } = loadAds();
const details = readJson('raw_details.json');
const labels = readJson('labels.json');
const rows = ads.map((ad) => ({ ad, facts: factsFromListing(ad, details[ad.id], labels[ad.id]), c: classifyListing(ad, details[ad.id], labels[ad.id]) }));
const pct = (n, of) => `${((100 * n) / of).toFixed(1)}%`;

const byModel = {};
for (const r of rows) (byModel[r.c.model] ||= []).push(r);
console.log(`${rows.length} listings, ${pct(rows.filter((r) => r.c.trim === UNKNOWN).length, rows.length)} unknown trim\n`);
for (const [model, list] of Object.entries(byModel).sort((a, b) => b[1].length - a[1].length)) {
  const unknown = list.filter((r) => r.c.trim === UNKNOWN).length;
  console.log(`${model}: ${list.length} listings, ${unknown} unknown (${pct(unknown, list.length)})`);
  for (const trim of [...(TRIMS[model] || []), UNKNOWN]) {
    const t = list.filter((r) => r.c.trim === trim);
    if (!t.length) continue;
    const hoch = t.filter((r) => r.c.confidence === 'hoch').length;
    console.log(`  ${trim.padEnd(18)} ${String(t.length).padStart(5)}  ${trim === UNKNOWN ? '' : `(${hoch} hoch, ${t.length - hoch} mittel)`}`);
  }
}

const rules = {};
for (const r of rows) rules[r.c.rule.replace(/-\d+kW/, '-<kW>')] = (rules[r.c.rule.replace(/-\d+kW/, '-<kW>')] || 0) + 1;
console.log('\nrules that fired:');
for (const [rule, n] of Object.entries(rules).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${rule}`);

const line = (r) => {
  const f = r.facts;
  const reg = f.reg == null ? '?' : `${Math.round((f.reg % 1) * 12 + 1)}/${Math.floor(f.reg)}`;
  return `${r.ad.id} | ${r.c.model} | ${f.text.replace(/\s+/g, ' ').slice(0, 110)} | ${f.powerKw ?? '?'} kW | EZ ${reg} | ` +
    `${f.batteryKwh ?? '-'} kWh | drive ${f.drive ?? '-'} | AI ${f.aiTrim ?? '-'}\n    -> ${r.c.label} (${r.c.confidence}, ${r.c.rule})`;
};

// trims the listings name in their text (power not consulted), per kW value
// and era; values where 92%+ of 5+ cars agree are the ones POWER_TRIM keeps
if (process.argv.includes('--power')) {
  const byKw = {};
  for (const { facts: f } of rows) {
    const c = classify({ ...f, aiTrim: null, powerKw: null });
    if (c.confidence !== 'hoch' || !LR_RWD_FROM[c.model] || f.powerKw == null || f.reg == null) continue;
    const key = `${c.model} ${f.reg >= LR_RWD_FROM[c.model] ? 'since' : 'before'} ${f.powerKw}`;
    (byKw[key] ||= {})[c.trim] = (byKw[key][c.trim] || 0) + 1;
  }
  console.log('\npower values with one trim (92%+ of 5+ listings):');
  for (const [key, trims] of Object.entries(byKw).sort()) {
    const total = Object.values(trims).reduce((a, b) => a + b, 0);
    const [trim, n] = Object.entries(trims).sort((a, b) => b[1] - a[1])[0];
    if (total >= 5 && n / total >= 0.92) console.log(`  ${key.padEnd(24)} ${trim.padEnd(16)} ${n}/${total}`);
  }
}

if (process.argv.includes('--unknowns')) {
  console.log('\nunknown trims:');
  for (const r of rows.filter((x) => x.c.trim === UNKNOWN)) console.log(line(r));
}

const n = arg('--sample', 0);
if (n) {
  // mulberry32: a fixed seed gives the same sample on every run
  let s = arg('--seed', 1) >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...rows];
  console.log(`\nrandom sample of ${n} (seed ${arg('--seed', 1)}):`);
  for (let i = 0; i < n && pool.length; i++) console.log(line(pool.splice(Math.floor(rand() * pool.length), 1)[0]));
}
