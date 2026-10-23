// Labels the cars in <data>/label_queue.json with a headless Claude Code run
// instead of the API (no ANTHROPIC_API_KEY needed, uses your Claude login),
// then merges the results and retrains so the dashboard shows them vetted.
//
//   npm run label-claude
//
// Claude may only read files and write into <data>/label_results/;
// label.js validates every label before it reaches labels.json.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DATA } = require('../src/paths');
const { QUEUE, RESULTS_DIR } = require('./labels');

const ROOT = path.join(__dirname, '..');
const queued = fs.existsSync(QUEUE) ? JSON.parse(fs.readFileSync(QUEUE, 'utf8')).length : 0;
if (!queued) {
  console.log(`nothing queued (${QUEUE})`);
  process.exit(0);
}
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const PROMPT = `Label the ${queued} used-Tesla listings queued in ${QUEUE} for the Kurswert pricing engine.

Read SCHEMA and buildPrompt in ${path.join(__dirname, 'labels.js')} first: they define every field and the labeling rules, follow them exactly. Most important: a "Long Range" with an acceleration boost is NOT a Performance, call it "Long Range". The German seller description is the most reliable source; the structured damage field can be incomplete. Read every car yourself, do not classify with keyword scripts.

With more than 40 cars, split the queue into chunks of about 40 and hand each chunk to its own subagent in parallel, each writing its own file.

Write the labels as JSON objects keyed by listing id (string) into ${RESULTS_DIR}/ (for example chunk-1.json), each value exactly {trueTrim, trimConfidence, condition, batteryIssue, isImport, commercialUse, priceCaveats, labeledBy: "claude-code-subagent"}. Every queued id must get a label. Do not modify any other file. Reply with the number of cars labeled and list any car that is not clean or has a battery issue.`;

const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...extra });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

console.log(`labeling ${queued} queued cars with Claude Code...`);
run('claude', ['-p', PROMPT, '--allowedTools', 'Read', 'Write', 'Agent', '--add-dir', DATA]);
run('node', ['pricing/label.js'], { env: { ...process.env, LABEL_MODE: 'queue' } });
run('node', ['pricing/train.js']);
