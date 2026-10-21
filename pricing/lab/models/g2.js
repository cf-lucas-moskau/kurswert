const { makeGbm } = require('../gbmModel'); module.exports = makeGbm({ gbm: { nTrees: 800, lr: 0.03, depth: 5, minLeaf: 5 } });
