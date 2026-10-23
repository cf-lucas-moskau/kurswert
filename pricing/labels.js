// What a label is and which cars still need one. Shared by the API labeler
// (label.js), the Claude Code labeler (label_claude.js) and train.js, which
// marks queued cars as pendingLabel so they never show as a deal unvetted.
//
// Without API access the labeler writes the cars it could not label to
// <data>/label_queue.json. Whoever labels them (a Claude Code run) writes
// { "<id>": <label>, ... } files into <data>/label_results/; the next
// `npm run label` validates and merges them into labels.json.
const fs = require('fs');
const path = require('path');
const { dataFile } = require('../src/paths');

const QUEUE = dataFile('label_queue.json');
const RESULTS_DIR = dataFile('label_results');

const CONDITIONS = ['clean', 'repaired_damage', 'accident_unrepaired', 'not_roadworthy', 'salvage'];
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    trueTrim: {
      type: 'string',
      description:
        'The actual trim, using Tesla knowledge, even if the title is misleading. Model 3/Y: "Standard Range", "Standard Range Plus", "Long Range", "Performance". Model S/X: battery tier like "75D"/"90D"/"100D", or "Performance", "Plaid", "Long Range". A "Long Range" with an acceleration boost is NOT a Performance — call it "Long Range". If genuinely unclear, give your best single guess.',
    },
    trimConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    condition: {
      type: 'string',
      enum: CONDITIONS,
      description:
        'clean = no damage mentioned or explicitly accident-free; repaired_damage = had damage, professionally repaired; accident_unrepaired = damaged, not repaired; not_roadworthy = cannot legally drive; salvage = for parts/export-only/total loss.',
    },
    batteryIssue: { type: 'boolean', description: 'Battery pack defective, degraded, or flagged as needing replacement.' },
    isImport: { type: 'boolean', description: 'Foreign-market or US import, or explicitly not a German-market car.' },
    commercialUse: { type: 'boolean', description: 'Used as taxi, rental, driving school, or fleet vehicle.' },
    priceCaveats: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short phrases naming anything that materially lowers value (e.g. "repaired accident", "battery defective", "high wear"). Empty if none.',
    },
  },
  required: ['trueTrim', 'trimConfidence', 'condition', 'batteryIssue', 'isImport', 'commercialUse', 'priceCaveats'],
};

const stripHtml = (h) =>
  (h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// a mobile.de car with a fetched seller description and no label yet
function needsLabel(ad, details, labels) {
  const d = details[ad.id];
  return !!(d && !d.gone && d.htmlDescription && !(ad.id in labels));
}

// the facts a labeler reads, identical for the API prompt and the queue file
function facts(ad, detail) {
  const attrs = {};
  for (const a of detail?.attributes || []) attrs[a.tag] = a.value;
  return {
    id: ad.id,
    model: ad.model,
    title: `${ad.shortTitle || ''} ${ad.subTitle || ''}`.trim(),
    power: ad.attr?.pw || attrs.power || '?',
    firstRegistration: ad.attr?.fr || attrs.firstRegistration || '?',
    mileage: ad.attr?.ml || attrs.mileage || '?',
    damageCondition: attrs.damageCondition || '(none)',
    description: stripHtml(detail?.htmlDescription).slice(0, 2000) || '(none)',
  };
}

function buildPrompt(f) {
  return `You are labeling a used Tesla listing from mobile.de (German market) so a dealer's pricing engine can value it correctly. Read the German text carefully and extract structured facts.

Model: ${f.model}
Title: ${f.title}
Power: ${f.power}
First registration: ${f.firstRegistration}
Mileage: ${f.mileage}
Structured condition field: ${f.damageCondition}
Seller description: ${f.description}

Extract the true trim (do not be fooled by loose use of the word "Performance" — a Long Range with an acceleration upgrade is still a Long Range), the accident/damage condition, and any battery/import/commercial-use flags. The seller description is the most reliable source; the structured field can be incomplete.`;
}

// returns the reason a label is malformed, or null
function invalidReason(l) {
  if (!l || typeof l !== 'object') return 'not an object';
  if (typeof l.trueTrim !== 'string' || !l.trueTrim) return 'trueTrim';
  if (!SCHEMA.properties.trimConfidence.enum.includes(l.trimConfidence)) return 'trimConfidence';
  if (!CONDITIONS.includes(l.condition)) return 'condition';
  for (const k of ['batteryIssue', 'isImport', 'commercialUse']) if (typeof l[k] !== 'boolean') return k;
  if (!Array.isArray(l.priceCaveats) || l.priceCaveats.some((c) => typeof c !== 'string')) return 'priceCaveats';
  return null;
}

// Merges every result file into labels (mutated), then deletes the files.
// Malformed entries are skipped; their cars stay queued for the next pass.
function mergeResults(labels, knownIds) {
  if (!fs.existsSync(RESULTS_DIR)) return { merged: 0, rejected: [] };
  let merged = 0;
  const rejected = [];
  for (const file of fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const full = path.join(RESULTS_DIR, file);
    let batch;
    try { batch = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { rejected.push(`${file}: not JSON`); continue; }
    for (const [id, l] of Object.entries(batch)) {
      const why = knownIds.has(id) ? invalidReason(l) : 'unknown id';
      if (why) { rejected.push(`${id}: ${why}`); continue; }
      labels[id] = { labeledBy: 'claude-code-subagent', ...l };
      merged++;
    }
    fs.rmSync(full);
  }
  return { merged, rejected };
}

function writeQueue(items) {
  if (items.length) fs.writeFileSync(QUEUE, JSON.stringify(items, null, 1));
  else fs.rmSync(QUEUE, { force: true });
}

module.exports = { QUEUE, RESULTS_DIR, SCHEMA, needsLabel, facts, buildPrompt, invalidReason, mergeResults, writeQueue };
