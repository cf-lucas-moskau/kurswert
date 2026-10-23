// Tracks each listing's asking price over time. mobile.de shows no price
// history, but a seller cutting the price is the classic motivated-seller
// signal dealers act on — so every scrape/fetch observes the current price and
// appends a dated entry whenever it changed.
//
// data/price_history.json: { "<id>": [["YYYY-MM-DD", price], ...] } — first
// entry is the price when we first saw the car, later entries only on change.
const fs = require('fs');
const path = require('path');

const FILE = process.env.PRICE_HISTORY_FILE || require('../src/paths').dataFile('price_history.json');

let cache = null;
function load() {
  if (!cache) cache = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
  return cache;
}

// Records the current asking price of each ad (raw mobile.de ad objects).
// Appends only when the price differs from the last recorded one, so calling
// this repeatedly on unchanged data is a no-op.
function observe(ads, today) {
  const map = load();
  const day = today || new Date().toISOString().slice(0, 10);
  let changes = 0;
  let added = 0;
  for (const ad of ads) {
    const price = ad?.price?.grossAmount;
    if (ad?.id == null || !(price > 0)) continue;
    const hist = map[ad.id] || (map[ad.id] = []);
    const last = hist[hist.length - 1];
    if (!last) {
      hist.push([day, price]);
      added++;
    } else if (last[1] !== price) {
      // same-day flip-flops collapse to the latest price of the day — but never
      // overwrite the baseline entry, or a first-day cut would vanish
      if (last[0] === day && hist.length > 1) hist[hist.length - 1] = [day, price];
      else hist.push([day, price]);
      changes++;
    }
  }
  if (added || changes) fs.writeFileSync(FILE, JSON.stringify(map));
  return { changes, added };
}

function historyFor(id) {
  return load()[id] || [];
}

// Drop summary for one listing, or null when there is no net price cut.
//   drops         number of downward moves observed
//   firstPrice    price when we first saw the car
//   previousPrice price immediately before the latest cut
//   lastDropDate  date of the latest cut
//   totalDropPct  current vs first price, rounded (negative = cheaper now)
const MIN_DROP_PCT = 1; // net cut needed before a listing counts as reduced

function dropInfo(id) {
  const hist = historyFor(id);
  if (hist.length < 2) return null;
  let drops = 0;
  let lastDropDate = null;
  let previousPrice = null;
  for (let i = 1; i < hist.length; i++) {
    if (hist[i][1] < hist[i - 1][1]) {
      drops++;
      lastDropDate = hist[i][0];
      previousPrice = hist[i - 1][1];
    }
  }
  const firstPrice = hist[0][1];
  const current = hist[hist.length - 1][1];
  const totalDropPct = ((current - firstPrice) / firstPrice) * 100;
  // no net cut, or a cosmetic one (16,999 -> 16,990 re-lists the ad): no signal
  if (drops === 0 || totalDropPct > -MIN_DROP_PCT) return null;
  return {
    drops,
    firstPrice,
    previousPrice,
    lastDropDate,
    totalDropPct: Math.round(totalDropPct),
  };
}

module.exports = { load, observe, historyFor, dropInfo };
