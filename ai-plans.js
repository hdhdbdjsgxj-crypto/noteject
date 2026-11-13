(root => {
  'use strict';
  const plans = Object.freeze([
    { id: 'free', name: 'Free', price: '$0', cadence: 'forever', description: 'Read, annotate, and try cited AI.', features: ['PDF reader and annotations', '10 basic AI actions / month'], backup: true },
    { id: 'starter', name: 'Starter', price: '$5.99', cadence: 'month', description: 'For everyday document questions.', features: ['PDF tools', '200 basic AI actions / month', '10 advanced AI actions / month', 'AI audio transcription · one advanced action per 2 minutes'], backup: true },
    { id: 'pro', name: 'Pro', price: '$12.99', cadence: 'month', description: 'More AI for deeper research.', features: ['Cited questions and document summaries', '1,000 basic AI actions / month', '100 advanced AI actions / month', 'AI audio transcription · one advanced action per 2 minutes', 'OCR is planned and is not included yet'], backup: true, featured: true },
    { id: 'team', name: 'Team', price: '$34.99', cadence: 'month', description: 'Unlimited members in one shared research workspace — planned.', features: ['Unlimited users and shared documents — planned', '5,000 basic AI actions / month — planned', '250 advanced AI actions / month — planned', 'AI audio transcription — planned'], backup: true, planned: true }
  ]);
  const mounted = new WeakSet(), generations = new WeakMap();
  let busy = false;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function formatStorage(bytes) {
    const size = Number(bytes) || 0, gb = 1024 * 1024 * 1024;
    if (size >= gb) return `${(size / gb).toFixed(size % gb ? 1 : 0)} GB`;
    return `${Math.max(1, Math.round(size / (1024 * 1024)))} MB`;
  }
  function render() {
    const hosted = !!root.NotejectWebApp;
    return `<section class="ai-plans-card" aria-labelledby="ai-plans-title">
      <header class="ai-plans-heading"><div><span class="eyebrow">NOTEJECT AI PLANS</span><h2 id="ai-plans-title">Choose your workspace plan</h2><p>Ask about documents and open the cited source passages.</p></div></header>
      <div class="ai-account-status" data-ai-account-status role="status">${hosted ? 'Sign in to see your plan and monthly usage.' : 'Connect Noteject Cloud to use a Noteject plan.'}</div>
      <div class="ai-plan-grid">${plans.map(plan => `<article class="ai-plan-card${plan.featured ? ' is-featured' : ''}" aria-label="${esc(plan.name)} plan">
        ${plan.featured ? '<span class="ai-plan-badge">MORE AI ACTIONS</span>' : ''}
        <header><h3>${esc(plan.name)}</h3><p>${esc(plan.description)}</p></header>
        <div class="ai-plan-price"><strong>${esc(plan.price)}</strong><span>/${esc(plan.cadence)}</span></div>
        <ul>${plan.features.map(feature => `<li>${esc(feature)}</li>`).join('')}${plan.backup ? `<li data-plan-backup="${esc(plan.id)}" hidden>Cloud backup space</li>` : ''}</ul>
        ${plan.id !== 'free' ? `<button type="button" class="ai-plan-button" data-ai-upgrade="${plan.id}" disabled>${plan.planned ? 'Coming soon' : 'Checking availability…'}</button>` : '<span class="ai-plan-free">Available with a free account</span>'}
      </article>`).join('')}</div>
      <div class="ai-plan-account-actions"><button type="button" class="ai-plan-button" data-ai-manage hidden>Manage subscription</button><button type="button" class="ai-plan-button" data-ai-refresh>Refresh plan and usage</button></div>
      <p data-ai-plan-status class="ai-plan-status" role="status"></p>
      <div class="ai-plans-notice"><b>How actions work</b><span>Each submitted question or summary uses one action in the selected Basic or Advanced mode. Allowances reset at the start of each calendar month in UTC. Payment confirmation controls access. Team subscriptions and OCR are not available yet.</span></div>
    </section>`;
  }
  async function mount(force = false) {
    const section = root.document.querySelector('.ai-plans-card');
    if (!section || !root.NotejectCloud || (!force && mounted.has(section))) return;
    mounted.add(section);
    const generation = (generations.get(section) || 0) + 1;
    generations.set(section, generation);
    const current = () => section.isConnected && generations.get(section) === generation;
    const status = section.querySelector('[data-ai-plan-status]');
    try {
      const response = await root.fetch(root.NotejectCloud.apiOrigin() + '/api/site-config', { cache: 'no-store' });
      const config = response.ok ? await response.json() : {};
      const account = await root.NotejectCloud.getAccount();
      if (!current()) return;
      const translate = text => root.NotejectI18n?.t?.(text) || text;
      for (const item of section.querySelectorAll('[data-plan-backup]')) {
        const bytes = Number(config.backupQuotas?.[item.dataset.planBackup]);
        if (Number.isFinite(bytes) && bytes > 0) {
          item.textContent = `${formatStorage(bytes)}${item.dataset.planBackup === 'team' ? ` · ${translate('shared by the team')}` : ''} ${translate('private cloud backup')}`;
          item.hidden = false;
        }
      }
      section.querySelector('[data-ai-account-status]').textContent = account
        ? `${translate(plans.find(plan => plan.id === account.plan)?.name || 'Free')} · ${translate('Basic')}: ${account.basic.used} / ${account.basic.limit} · ${translate('Advanced')}: ${account.advanced.used} / ${account.advanced.limit}. ${translate('Resets monthly at 00:00 UTC on the first day of the month.')}${account.cancelAtPeriodEnd ? ` ${translate('Subscription ends after the paid period.')}` : ''}`
        : translate('Sign in to see your plan and monthly usage.');
      const available = config.checkoutPlans || [];
      for (const button of section.querySelectorAll('[data-ai-upgrade]')) {
        const id = button.dataset.aiUpgrade;
        const active = account?.plan === id;
        button.disabled = id === 'team' || active || !available.includes(id);
        button.dataset.aiBillingAction = account && account.plan !== 'free' ? 'portal' : 'checkout';
        button.textContent = active ? 'Current plan' : available.includes(id) ? (account && account.plan !== 'free' ? 'Change subscription' : account ? 'Choose ' + plans.find(plan => plan.id === id).name : 'Sign in to choose') : 'Coming soon';
      }
      section.querySelector('[data-ai-manage]').hidden = !account?.canManageSubscription;
      status.textContent = config.aiEnabled ? 'Your plan includes AI access. No personal AI key is needed.' : 'AI is awaiting service setup. Reading and local tools are available.';
      const returned = new URLSearchParams(root.location.search).get('billing');
      if (returned === 'success' && account?.plan === 'free') status.textContent = 'Your payment is being confirmed. Refresh your plan shortly; your allowance updates after confirmation.';
      if (returned === 'cancelled') status.textContent = 'Checkout was cancelled. Your plan has not changed.';
    } catch (error) {
      if (current()) status.textContent = error.message || 'Could not load your plan. Please refresh.';
    }
  }
  root.document.addEventListener('noteject-account-changed', () => { void mount(true); });
  root.document.addEventListener('click', async event => {
    const button = event.target.closest('[data-ai-upgrade],[data-ai-manage],[data-ai-refresh]');
    if (!button || button.disabled || busy) return;
    if (button.hasAttribute('data-ai-refresh')) { void mount(true); return; }
    const section = button.closest('.ai-plans-card'), status = section.querySelector('[data-ai-plan-status]');
    busy = true; button.disabled = true;
    try {
      const action = button.hasAttribute('data-ai-manage') ? 'portal' : button.dataset.aiBillingAction;
      const url = await root.NotejectCloud.startBilling(action, button.dataset.aiUpgrade);
      if (url) root.location.assign(url);
    } catch (error) { status.textContent = error.message || 'Could not open subscriptions.'; }
    finally { busy = false; if (button.isConnected) button.disabled = false; }
  });
  root.NotejectAiPlans = Object.freeze({ render, mount, plans });
})(window);
