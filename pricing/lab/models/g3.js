const { makeGbm } = require('../gbmModel'); module.exports = makeGbm({ gbm: { nTrees: 600, lr: 0.05, depth: 3, minLeaf: 8 } });
