const { makeEnsemble } = require('../ensemble'); module.exports = makeEnsemble([require('./best_ridge'), require('./g4_huber')], [0.5, 0.5]);
