'use strict';
const { json } = require('./_shared');
module.exports = function handler(req, res) {
  json(res, 403, { error: 'Personal API keys are not supported. Sign in to Noteject and use your plan allowance.' });
};
