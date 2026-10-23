// Tracks when we first observed each listing id. mobile.de does not expose
// an absolute go-live date, but across repeated scrapes this gives a real
// "new to us" signal: any id we have not recorded before is a fresh arrival.
const fs = require('fs');
const path = require('path');

const FILE = require('../src/paths').dataFile('first_seen.json');

function load() {
  return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
}

// Stamps any unseen ids with the current ISO time (older entries are plain
// YYYY-MM-DD dates). Returns the full map and the set of ids that were new in
// this call.
function stamp(ids, now) {
  const map = load();
  const isNew = new Set();
  const at = now || new Date().toISOString();
  for (const id of ids) {
    if (!(id in map)) {
      map[id] = at;
      isNew.add(id);
    }
  }
  fs.writeFileSync(FILE, JSON.stringify(map));
  return { map, isNew };
}

module.exports = { load, stamp };
