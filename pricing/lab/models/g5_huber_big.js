const { makeGbm } = require('../gbmModel'); module.exports = makeGbm({ gbm: { nTrees: 800, lr: 0.03, depth: 4, minLeaf: 6, loss: 'huber', huberDelta: 0.06, colsample: 0.7 } });
