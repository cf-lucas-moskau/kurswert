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
//   LABEL_MODE=queue node pricing/label.js              # never call the API
//
// Uses ANTHROPIC_API_KEY (from the environment or <repo>/.env.local, or
// `ant auth login`). Without API access, or when the API fails, it writes
// the unlabeled cars to <data>/label_queue.json for `npm run label-claude`.
// Every run first merges label files from <data>/label_results/. Resumable:
// only cars not already in labels.json are labeled. Needs detail data
// (htmlDescription) from `npm run details`. Schema and rules: labels.js.
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { dataFile } = require('../src/paths');
require('../src/env').loadEnvLocal();
const { QUEUE, SCHEMA, needsLabel, facts, buildPrompt, mergeResults, writeQueue } = require('./labels');

const RAW = dataFile('raw_ads.json');
const DETAILS = dataFile('raw_details.json');
const LABELS = dataFile('labels.json');
const MODEL = process.env.LABEL_MODEL || 'claude-haiku-4-5'; // cheap, strong at extraction; override for a higher-quality pass
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const CONCURRENCY = 5;

const isAuthError = (e) => e?.status === 401 || e instanceof Anthropic.AuthenticationError || /api[_ -]?key|authenticat/i.test(e?.message || '');

async function label(client, f) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: buildPrompt(f) }],
  });
  const text = resp.content.find((b) => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

(async () => {
  const ads = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const details = fs.existsSync(DETAILS) ? JSON.parse(fs.readFileSync(DETAILS, 'utf8')) : {};
  const labels = fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, 'utf8')) : {};

  const { merged, rejected } = mergeResults(labels, new Set(ads.map((a) => String(a.id))));
  if (merged || rejected.length) {
    fs.writeFileSync(LABELS, JSON.stringify(labels));
    console.log(`merged ${merged} labels from label_results/${rejected.length ? `, rejected ${rejected.length}: ${rejected.join('; ')}` : ''}`);
  }

  const todo = ads.filter((a) => needsLabel(a, details, labels));
  const batch = LIMIT ? todo.slice(0, LIMIT) : todo;
  let useApi = process.env.LABEL_MODE !== 'queue';
  console.log(`${ads.length} ads, ${Object.keys(labels).length} already labeled, ${todo.length} labelable, ${useApi ? `doing ${batch.length} (model ${MODEL})` : 'queue mode'}`);

  let done = 0;
  let failed = 0;
  if (useApi && batch.length) {
    const client = new Anthropic();
    const queue = [...batch];
    async function worker() {
      while (useApi && queue.length) {
        const ad = queue.shift();
        try {
          labels[ad.id] = await label(client, facts(ad, details[ad.id]));
        } catch (e) {
          if (isAuthError(e)) { useApi = false; break; }
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
    if (!useApi) console.log('no Claude API access, queueing the rest');
    fs.writeFileSync(LABELS, JSON.stringify(labels));
  }

  const remaining = todo.filter((a) => !(a.id in labels));
  writeQueue(remaining.map((a) => facts(a, details[a.id])));
  console.log(`\nDONE: ${done} labeled this run (${failed} failed), ${Object.keys(labels).length} total -> ${LABELS}`);
  if (remaining.length) console.log(`${remaining.length} cars queued in ${QUEUE}; label them with: npm run label-claude`);
})();
