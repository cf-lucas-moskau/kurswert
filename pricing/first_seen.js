// Tracks the first date we observed each listing id. mobile.de does not expose
// an absolute go-live date, but across repeated scrapes this gives a real
// "new to us" signal: any id we have not recorded before is a fresh arrival.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'first_seen.json');

function load() {
  return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
}

// Stamps any unseen ids with today's date (YYYY-MM-DD). Returns the full map
// and the set of ids that were new in this call.
function stamp(ids, today) {
  const map = load();
  const isNew = new Set();
  const day = today || new Date().toISOString().slice(0, 10);
  for (const id of ids) {
    if (!(id in map)) {
      map[id] = day;
      isNew.add(id);
    }
  }
  fs.writeFileSync(FILE, JSON.stringify(map));
  return { map, isNew };
}

module.exports = { load, stamp };
