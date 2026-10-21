const { makeGbm } = require('../gbmModel'); module.exports = makeGbm({ gbm: { nTrees: 400, lr: 0.05, depth: 4, minLeaf: 8, loss: 'huber', huberDelta: 0.04 } });
