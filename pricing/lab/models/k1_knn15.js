const { makeKnnResid } = require('../knnModel'); module.exports = makeKnnResid(require('./best_ridge'), { k: 15 });
