const { makeKnnResid } = require('../knnModel'); module.exports = makeKnnResid(require('./best_ridge'), { k: 8, shrink: 5 });
