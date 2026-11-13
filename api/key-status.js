'use strict';
const { json, preflight } = require('./_shared');
module.exports = function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  json(res, 200, { configured: !!process.env.OPENAI_API_KEY, hosted: true, serviceVersion: 3 });
};
