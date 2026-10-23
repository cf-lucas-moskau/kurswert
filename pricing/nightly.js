// The full market refresh, in order, for an unattended nightly run:
//
//   npm run nightly               # run, or resume the last unfinished run
//   npm run nightly -- --fresh    # start over even if the last run is unfinished
//   npm run nightly -- --dry-run  # log the plan, run nothing, change nothing
//
// Resumable at two levels: each step's script checkpoints its own progress,
// and <data>/nightly_state.json records finished steps, so a rerun after a
// crash skips them (the resets in particular never run twice in one refresh).
// value-newest runs before details/label/train so the fresh arrivals it merges
// get vetted in the same pass. ANTHROPIC_API_KEY comes from the environment or
// <repo>/.env.local, so label runs via the API. Without it, label queues the unlabeled
// cars (see label.js); train marks them pendingLabel so they are shown but are
// never a deal until `npm run label-claude` has vetted them.
//
// Output goes to <data>/nightly.log, ending with a one-line summary.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA, dataFile } = require('../src/paths');
const Deal = require('../web/deal');
const { loadEnvLocal } = require('../src/env');

const ROOT = path.join(__dirname, '..');

const STEPS = [
  { name: 'reset-mobile', reset: ['raw_ads.json', 'progress.json'] },
  { name: 'scrape', script: 'src/scrape.js' },
  { name: 'reset-as24', reset: ['raw_ads_as24.json', 'progress_as24.json'] },
  { name: 'scrape-as24', script: 'src/scrape_autoscout.js' },
  { name: 'value-newest', script: 'pricing/value_newest.js' },
  { name: 'details', script: 'src/fetch_details.js' },
  { name: 'label', script: 'pricing/label.js' },
  { name: 'train', script: 'pricing/train.js' },
];

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

// Runs the steps not yet completed in the current run. exec(step) resolves to
// true on success. State is saved after every step when statePath is set.
async function runNightly({ steps, statePath, exec, log, fresh = false, now = () => new Date().toISOString() }) {
  let state = statePath ? readJson(statePath, null) : null;
  if (!state || state.finishedAt || fresh) state = { startedAt: now(), completed: [] };
  else log(`resuming run from ${state.startedAt}, done: ${state.completed.join(', ') || 'nothing'}`);
  const save = () => statePath && fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  save();
  for (const step of steps) {
    if (state.completed.includes(step.name)) continue;
    log(`step ${step.name}: start`);
    if (!(await exec(step))) {
      log(`step ${step.name}: FAILED, rerun npm run nightly to resume here`);
      save();
      return { ok: false, state };
    }
    state.completed.push(step.name);
    save();
    log(`step ${step.name}: done`);
  }
  state.finishedAt = now();
  save();
  return { ok: true, state };
}

// New cars = first seen since the run started; deals use the dashboard defaults.
function summarize({ listings, calibration, startedAt, queued }) {
  const since = Date.parse(startedAt);
  const isNew = (l) => l.firstSeen && Date.parse(l.firstSeen) >= since;
  const terms = Deal.defaultTerms(calibration);
  const deals = listings.map((l) => Deal.withDeal(l, terms)).filter((l) => l.isDealNow);
  const newOn = (src) => listings.filter((l) => l.source === src && isNew(l)).length;
  return `nightly ${startedAt.slice(0, 16)}: ${newOn('mobile.de')} new on mobile.de, ${newOn('autoscout24')} new on AutoScout24, ` +
    `${deals.length} deals (${deals.filter(isNew).length} among new cars), ${queued} cars queued for labeling`;
}

function makeLogger(file) {
  return (line) => {
    const out = `[${new Date().toISOString()}] ${line}\n`;
    process.stdout.write(out);
    fs.appendFileSync(file, out);
  };
}

// one run at a time: a second nightly (or a manual one) would fight over the
// same Chrome profiles and data files
function acquireLock(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    process.kill(pid, 0);
    return false;
  } catch {}
  fs.writeFileSync(file, String(process.pid));
  return true;
}

function execStep(step, logFile) {
  if (step.reset) {
    for (const f of step.reset) fs.rmSync(dataFile(f), { force: true });
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [step.script], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.openSync(logFile, 'a');
    const tee = (chunk) => { process.stdout.write(chunk); fs.writeSync(out, chunk); };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);
    child.on('close', (code) => { fs.closeSync(out); resolve(code === 0); });
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  fs.mkdirSync(DATA, { recursive: true });
  const logFile = dataFile('nightly.log');
  const log = makeLogger(logFile);
  const lock = dataFile('nightly.lock');
  if (!dryRun && !acquireLock(lock)) {
    log('another nightly run is in progress, exiting');
    process.exit(1);
  }
  log(`nightly ${dryRun ? 'dry run' : 'start'}, data dir ${DATA}`);
  const fromEnvFile = loadEnvLocal();
  if (fromEnvFile.length) log(`loaded ${fromEnvFile.join(', ')} from .env.local`);
  if (!process.env.ANTHROPIC_API_KEY) log('no ANTHROPIC_API_KEY: label will queue new cars for npm run label-claude');
  const exec = dryRun
    ? async (s) => (log(`  would ${s.reset ? `delete ${s.reset.join(', ')}` : `run node ${s.script}`}`), true)
    : (s) => execStep(s, logFile);
  const { ok, state } = await runNightly({
    steps: STEPS, exec, log, fresh: process.argv.includes('--fresh'),
    statePath: dryRun ? null : dataFile('nightly_state.json'),
  });
  if (!dryRun) fs.rmSync(lock, { force: true });
  if (!ok) process.exit(1);
  const { listings = [], calibration = null } = readJson(dataFile('valuations.json'), {});
  log(summarize({ listings, calibration, startedAt: state.startedAt, queued: readJson(dataFile('label_queue.json'), []).length }));
}

if (require.main === module) main();

module.exports = { STEPS, runNightly, summarize };
