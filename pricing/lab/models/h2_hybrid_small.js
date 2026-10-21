const { makeHybrid } = require('../ensemble'); module.exports = makeHybrid(require('./best_ridge'), { gbm: { nTrees: 100, lr: 0.05, depth: 2 } });
