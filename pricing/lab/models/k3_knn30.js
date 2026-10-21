const { makeKnnResid } = require('../knnModel'); module.exports = makeKnnResid(require('./best_ridge'), { k: 30, shrink: 10 });
