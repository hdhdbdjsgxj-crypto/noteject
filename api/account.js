'use strict';
const { requireUser, adminRequest, json, fail, preflight } = require('./_shared');
const { purchasablePlans, accountLiveMode, backupLimitBytes } = require('./_plans');
module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
  try {
    const auth = await requireUser(req);
    const account = await adminRequest('rpc/noteject_ai_account', { p_user_id: auth.user.id, p_livemode: accountLiveMode() });
    json(res, 200, { ...account, backupLimitBytes: backupLimitBytes(account?.plan), checkoutPlans: purchasablePlans(), aiEnabled: !!process.env.OPENAI_API_KEY });
  } catch (error) { fail(res, error, 'Could not load your plan.'); }
};
