// Where all mutable state lives: scraped data, labels, the trained model and
// the JSON feeds the dashboard serves. One directory, so nightly runs, manual
// runs from any checkout and the dashboard all share it.
//   KURSWERT_DATA=~/code/kurswert/data   (default: <repo>/data)
const os = require('os');
const path = require('path');

const raw = process.env.KURSWERT_DATA || path.join(__dirname, '..', 'data');
const DATA = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));

const dataFile = (name) => path.join(DATA, name);

module.exports = { DATA, dataFile };
