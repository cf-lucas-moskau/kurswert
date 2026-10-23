// Loads <repo>/.env.local (KEY=value lines, gitignored) into process.env, so
// unattended runs get ANTHROPIC_API_KEY without a shell profile. Variables
// already set in the environment win. A missing file is fine.
const fs = require('fs');
const path = require('path');

function loadEnvLocal(file = path.join(__dirname, '..', '.env.local')) {
  if (!fs.existsSync(file)) return [];
  const loaded = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    loaded.push(m[1]);
  }
  return loaded;
}

module.exports = { loadEnvLocal };
