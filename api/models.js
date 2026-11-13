'use strict';
const { json, preflight } = require('./_shared');
module.exports = function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  const configured = !!process.env.OPENAI_API_KEY;
  const model = String(process.env.OPENAI_MODEL || 'gpt-5-nano');
  json(res, 200, { models: configured ? [model] : [], source: 'noteject-cloud' });
};
