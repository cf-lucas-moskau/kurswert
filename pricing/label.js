// AI labeling pass: reads each car's free text (title, subtitle, seller
// description) plus its structured damage field and extracts the value-relevant
// facts that regex can't reliably parse — the true trim, accident/damage
// condition, battery issues, import and commercial-use flags.
//
// Why this exists: the biggest engine errors come from cars that are cheap for a
// reason hidden in prose (a "Basic Performance" that isn't a real Performance; a
// clean-looking listing whose description says the battery is defective). A
// small Claude call per car reads that prose and turns it into structured labels.
//
//   node pricing/label.js            # label all cars that have a description
//   LIMIT=10 node pricing/label.js   # test run
//   LABEL_MODEL=claude-opus-4-8 node pricing/label.js   # higher-quality pass
//
// Requires ANTHROPIC_API_KEY (or `ant auth login`). Resumable: caches to
// data/labels.json, only labels cars not already labeled. Needs detail data
// (htmlDescription) from `npm run details`.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { featurize } = require('./features');

const DATA = path.join(__dirname, '..', 'data');
const RAW = path.join(DATA, 'raw_ads.json');
const DETAILS = path.join(DATA, 'raw_details.json');
const LABELS = path.join(DATA, 'labels.json');
const MODEL = process.env.LABEL_MODEL || 'claude-haiku-4-5'; // cheap, strong at extraction; override for a higher-quality pass
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const CONCURRENCY = 5;

const client = new Anthropic();

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
      enum: ['clean', 'repaired_damage', 'accident_unrepaired', 'not_roadworthy', 'salvage'],
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

function buildPrompt(ad, detail) {
  const attrs = {};
  for (const a of detail?.attributes || []) attrs[a.tag] = a.value;
  const desc = stripHtml(detail?.htmlDescription).slice(0, 2000);
  return `You are labeling a used Tesla listing from mobile.de (German market) so a dealer's pricing engine can value it correctly. Read the German text carefully and extract structured facts.

Model: ${ad.model}
Title: ${ad.shortTitle || ''} ${ad.subTitle || ''}
Power: ${ad.attr?.pw || attrs.power || '?'}
First registration: ${ad.attr?.fr || attrs.firstRegistration || '?'}
Mileage: ${ad.attr?.ml || attrs.mileage || '?'}
Structured condition field: ${attrs.damageCondition || '(none)'}
Seller description: ${desc || '(none)'}

Extract the true trim (do not be fooled by loose use of the word "Performance" — a Long Range with an acceleration upgrade is still a Long Range), the accident/damage condition, and any battery/import/commercial-use flags. The seller description is the most reliable source; the structured field can be incomplete.`;
}

async function label(ad, detail) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: buildPrompt(ad, detail) }],
  });
  const text = resp.content.find((b) => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

(async () => {
  const ads = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const details = fs.existsSync(DETAILS) ? JSON.parse(fs.readFileSync(DETAILS, 'utf8')) : {};
  const labels = fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, 'utf8')) : {};

  // only cars with a fetched detail description, not already labeled
  const todo = ads.filter((a) => {
    const d = details[a.id];
    return d && !d.gone && d.htmlDescription && !(a.id in labels);
  });
  const batch = LIMIT ? todo.slice(0, LIMIT) : todo;
  console.log(`${ads.length} ads, ${Object.keys(labels).length} already labeled, ${todo.length} labelable, doing ${batch.length} (model ${MODEL})`);

  let done = 0;
  let failed = 0;
  const queue = [...batch];
  async function worker() {
    while (queue.length) {
      const ad = queue.shift();
      try {
        labels[ad.id] = await label(ad, details[ad.id]);
      } catch (e) {
        failed++;
        console.log(`  ${ad.id}: FAILED (${e.message.split('\n')[0]})`);
        continue;
      }
      done++;
      if (done % 10 === 0) {
        fs.writeFileSync(LABELS, JSON.stringify(labels));
        console.log(`  ${done}/${batch.length} labeled (${failed} failed)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(LABELS, JSON.stringify(labels));
  console.log(`\nDONE: ${done} labeled this run (${failed} failed), ${Object.keys(labels).length} total -> data/labels.json`);
})();
