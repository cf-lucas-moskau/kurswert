const { makeEnsemble } = require('../ensemble'); module.exports = makeEnsemble([require('./k1_knn15'), require('./g4_huber')], [0.7, 0.3]);
