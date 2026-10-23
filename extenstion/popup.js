// MarketLens 2.3 — popup
// Reads validated state, edits settings / tax config / rate card, exports and
// imports. All writes go through the background worker (single writer).

(function () {
  'use strict';

  const money = window.MarketLens.money;
  const dq = window.MarketLens.dq;
  const rules = window.MarketLens.rules;
  const storage = window.MarketLens.storage;

  let state = null;
  let issues = [];

  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 2600);
  }
  function send(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, resp => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: 'No response from the worker.' });
        });
      } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  }
  async function patch(partial) {
    const res = await send({ type: 'ml:patch', partial: partial });
    if (res.ok) state = res.state; else toast('Could not save: ' + res.error);
    return res;
  }
  function badge(text, tone) { return h('span', 'badge' + (tone ? ' ' + tone : ''), text); }

  async function init() {
    const res = await storage.load();
    state = res.state; issues = res.issues;
    renderPageCard();
    renderCapabilities();
    renderRules();
    renderTaxForm();
    renderSettings();
    renderDataStats();
    renderIssues();
    $('btn-sidebar').addEventListener('click', openSidebar);
    $('btn-export').addEventListener('click', doExport);
    $('import-file').addEventListener('change', doImport);
    $('btn-clear').addEventListener('click', doClear);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      storage.load().then(r => {
        state = r.state; issues = r.issues;
        renderRules(); renderSettings(); renderDataStats();
      }).catch(() => {});
    });
  }

  function renderPageCard() {
    const info = $('page-info');
    info.textContent = '';
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) {
        info.appendChild(h('p', 'note', 'No active tab.'));
        return;
      }
      info.appendChild(row('Page', tab.url.replace(/^https?:\/\//, '').split('?')[0]));
      info.appendChild(h('p', 'note', 'The popup cannot read the page itself — the sidebar does, and it shows every field with its provenance.'));
    });
    info.appendChild(row('Watchlist items', String(state.watchlist.length)));
    info.appendChild(row('Products with stored inputs', String(Object.keys(state.products || {}).length)));
    info.appendChild(row('Price observation sets', String(Object.keys(state.observations || {}).length)));
  }
  function row(label, value) {
    const r = h('div', 'row');
    r.appendChild(h('span', 'muted', label));
    r.appendChild(h('span', null, value));
    return r;
  }

  function openSidebar() {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id === undefined) { toast('No active tab.'); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'ml:toggleSidebar' }, resp => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          toast('No MarketLens sidebar on this page (supported marketplace pages only).');
        }
      });
    });
  }

  function renderCapabilities() {
    const wrap = $('capability-table');
    wrap.textContent = '';
    const table = h('table');
    const head = h('tr');
    for (const t of ['Marketplace', 'Extraction', 'Fee model', 'Profit model']) head.appendChild(h('th', null, t));
    table.appendChild(head);
    for (const id of Object.keys(rules.MARKETPLACES)) {
      const mp = rules.MARKETPLACES[id];
      const tr = h('tr');
      tr.appendChild(h('td', null, mp.label));
      const ex = mp.capabilities.extraction;
      tr.appendChild(h('td', null, ex === 'implemented'
        ? (mp.capabilities.extractionTested ? 'implemented (tested)' : 'implemented — not tested live')
        : ex === 'best_effort' ? 'best-effort only' : String(ex)));
      const feeTone = mp.capabilities.feeModel === 'not_implemented' ? 'warn' : 'ok';
      const feeLabel = mp.capabilities.feeModel === 'not_implemented' ? 'not implemented'
        : mp.capabilities.feeModel === 'seller_defined' ? 'seller-defined only' : 'structure — you supply rates';
      const td2 = h('td'); td2.appendChild(badge(feeLabel, feeTone)); tr.appendChild(td2);
      const td3 = h('td');
      td3.appendChild(badge(mp.capabilities.profitModel ? 'available' : 'not available', mp.capabilities.profitModel ? 'ok' : 'bad'));
      tr.appendChild(td3);
      table.appendChild(tr);
    }
    wrap.appendChild(table);
  }

  function renderRules() {
    const wrap = $('rules-list');
    wrap.textContent = '';
    const byMp = {};
    for (const rule of state.feeRules || []) (byMp[rule.marketplace] = byMp[rule.marketplace] || []).push(rule);
    const keys = Object.keys(byMp);
    if (!keys.length) {
      wrap.appendChild(h('p', 'note', 'No seller rules yet. Enter your rates from a product page sidebar (Profit & Settlement → Your fee rate card). Until then every fee is reported as missing.'));
    }
    for (const mp of keys) {
      wrap.appendChild(h('h3', null, rules.marketplace(mp).label + ' — ' + byMp[mp].length + ' rule(s)'));
      for (const rule of byMp[mp]) {
        const r = h('div', 'row');
        const left = h('div');
        left.style.minWidth = '0';
        left.appendChild(h('div', null, (rules.FEE_TYPES[rule.feeType] ? rules.FEE_TYPES[rule.feeType].label : rule.feeType) + ' · ' + rules.describe(rule)));
        const fresh = dq.freshness(rule.lastVerifiedAt);
        left.appendChild(h('div', 'note', dq.label(rule.verification || 'seller_confirmed') + ' — ' + fresh.note));
        r.appendChild(left);
        const del = h('button', 'danger small', 'Delete');
        del.addEventListener('click', async () => {
          if (!window.confirm('Delete this rule? Fees that used it will report as missing.')) return;
          const next = state.feeRules.filter(x => x.id !== rule.id);
          await patch({ feeRules: next });
          renderRules();
        });
        r.appendChild(del);
        wrap.appendChild(r);
      }
    }
  }

  function renderTaxForm() {
    const wrap = $('tax-form');
    wrap.textContent = '';
    const cfg = state.taxConfig || {};
    const grid = h('div', 'grid2');

    grid.appendChild(field('GST registered?', selectInput(
      [{ value: '', label: 'Not configured' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
      cfg.gstRegistered === true ? 'yes' : cfg.gstRegistered === false ? 'no' : '',
      v => saveTax({ gstRegistered: v === '' ? null : v === 'yes' }))));
    grid.appendChild(field('Product GST %', numInput(cfg.gstRatePct, v => saveTax({ gstRatePct: v }))));
    grid.appendChild(field('Listed price includes GST?', selectInput(
      [{ value: '', label: 'Not configured' }, { value: 'incl', label: 'Yes, GST-inclusive' }, { value: 'excl', label: 'No, GST added on top' }],
      cfg.priceIncludesGst === true ? 'incl' : cfg.priceIncludesGst === false ? 'excl' : '',
      v => saveTax({ priceIncludesGst: v === '' ? null : v === 'incl' }))));
    grid.appendChild(field('Claim ITC on marketplace fees?', selectInput(
      [{ value: '', label: 'Not configured' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
      cfg.claimItcOnMarketplaceFees === true ? 'yes' : cfg.claimItcOnMarketplaceFees === false ? 'no' : '',
      v => saveTax({ claimItcOnMarketplaceFees: v === '' ? null : v === 'yes' }))));
    grid.appendChild(field('Claim ITC on product cost?', selectInput(
      [{ value: '', label: 'Not configured' }, { value: 'yes', label: 'Yes (enter GST-exclusive cost)' }, { value: 'no', label: 'No' }],
      cfg.claimItcOnProductCost === true ? 'yes' : cfg.claimItcOnProductCost === false ? 'no' : '',
      v => saveTax({ claimItcOnProductCost: v === '' ? null : v === 'yes' }))));
    grid.appendChild(field('TCS % withheld by marketplace', numInput(cfg.tcsPct, v => saveTax({ tcsPct: v }))));
    grid.appendChild(field('TDS % withheld by marketplace', numInput(cfg.tdsPct, v => saveTax({ tdsPct: v }))));
    grid.appendChild(field('Income tax % (flat, rough only)', numInput(cfg.incomeTaxPct, v => saveTax({ incomeTaxPct: v }))));
    wrap.appendChild(grid);
    wrap.appendChild(h('p', 'note', 'Unconfigured items are listed as EXCLUDED in the sidebar, never treated as zero. TCS/TDS are withheld in cash but creditable later. Verify treatment with your accountant — this is not tax advice.'));

    function saveTax(partial) {
      const taxConfig = Object.assign({}, state.taxConfig, partial);
      taxConfig.configured = taxConfig.gstRegistered !== null;
      patch({ taxConfig: taxConfig });
    }
  }
  function selectInput(options, value, onChange) {
    const s = h('select');
    for (const o of options) {
      const opt = h('option', null, o.label);
      opt.value = o.value;
      if (o.value === value) opt.selected = true;
      s.appendChild(opt);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function numInput(value, onChange) {
    const i = h('input');
    i.type = 'number'; i.step = '0.01'; i.min = '0'; i.placeholder = 'not set';
    if (typeof value === 'number' && Number.isFinite(value)) i.value = String(value);
    i.addEventListener('change', () => {
      const raw = i.value.trim();
      onChange(raw === '' ? null : Number(raw));
    });
    return i;
  }
  function field(labelText, inputEl) {
    const f = h('div', 'field');
    f.appendChild(h('label', null, labelText));
    f.appendChild(inputEl);
    return f;
  }

  function renderSettings() {
    const wrap = $('settings-form');
    wrap.textContent = '';
    const s = state.settings;

    const notify = h('input'); notify.type = 'checkbox'; notify.checked = !!s.notifications;
    notify.addEventListener('change', () => patch({ settings: { notifications: notify.checked } }));
    wrap.appendChild(checkRow('Price alerts & notifications', notify));

    const poll = h('input'); poll.type = 'number'; poll.min = '60'; poll.step = '30'; poll.value = String(s.pollIntervalMinutes || 360);
    poll.addEventListener('change', async () => {
      const minutes = Math.max(60, Number(poll.value) || 360);
      await patch({ settings: { pollIntervalMinutes: minutes } });
      toast('Interval saved. The alarm re-registers on the next extension start; reopen the browser if it does not update.');
    });
    wrap.appendChild(field('Watchlist auto re-check interval (minutes, minimum 60)', poll));

    const tol = h('input'); tol.type = 'number'; tol.step = '0.01'; tol.min = '0';
    tol.value = String(money.fromPaise(s.reconciliationTolerancePaise === null || s.reconciliationTolerancePaise === undefined ? 50 : s.reconciliationTolerancePaise));
    tol.addEventListener('change', () => patch({ settings: { reconciliationTolerancePaise: money.toPaise(tol.value) } }));
    wrap.appendChild(field('Statement tolerance ₹ (differences under this are shown as “within tolerance”, never hidden)', tol));
    wrap.appendChild(h('p', 'note', 'The auto re-check opens watched product pages in a background tab (up to 2 per run) and records only what is actually readable. Pages that cannot be read store nothing and raise nothing.'));
  }
  function checkRow(labelText, inputEl) {
    const r = h('div', 'row');
    const lab = h('label');
    lab.style.display = 'flex'; lab.style.alignItems = 'center'; lab.style.gap = '6px';
    lab.appendChild(inputEl);
    lab.appendChild(h('span', null, labelText));
    r.appendChild(lab);
    return r;
  }

  function renderDataStats() {
    const wrap = $('data-stats');
    wrap.textContent = '';
    wrap.appendChild(row('Seller rules', money.formatInt((state.feeRules || []).length)));
    wrap.appendChild(row('Watchlist items', money.formatInt(state.watchlist.length)));
    wrap.appendChild(row('Observation sets', money.formatInt(Object.keys(state.observations || {}).length)));
    wrap.appendChild(row('Comparable samples saved', money.formatInt(Object.keys(state.comparables || {}).length)));
  }

  function renderIssues() {
    if (!issues || !issues.length) return;
    $('issues-card').style.display = 'block';
    const list = $('issues-list');
    list.textContent = '';
    for (const i of issues) list.appendChild(h('li', null, i));
  }

  function doExport() {
    const json = storage.exportJSON(state);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'marketlens-export.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Exported. The file contains only your own data.');
  }

  function doImport(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const imported = storage.importJSON(String(reader.result));
      if (!imported.ok) { toast('Import failed: ' + (imported.error || 'unrecognised file')); return; }
      const st = imported.state;
      await patch({
        settings: st.settings, taxConfig: st.taxConfig, products: st.products, watchlist: st.watchlist,
        observations: st.observations, alerts: st.alerts, feeRules: st.feeRules, comparables: st.comparables, meta: st.meta
      });
      toast('Imported. Nothing left your browser.');
      renderRules(); renderDataStats();
      if (imported.issues && imported.issues.length) issues = imported.issues;
      renderIssues();
    };
    reader.readAsText(file);
    ev.target.value = '';
  }

  async function doClear() {
    if (!window.confirm('Delete ALL MarketLens data (watchlist, observations, seller inputs, rate card)? This cannot be undone.')) return;
    if (!window.confirm('Really delete everything? Export first if you are unsure.')) return;
    const res = await send({ type: 'ml:clearAll' });
    if (!res.ok) { toast('Could not clear: ' + res.error); return; }
    const fresh = await storage.load();
    state = fresh.state; issues = fresh.issues;
    renderRules(); renderSettings(); renderDataStats(); renderPageCard();
    toast('All local data deleted.');
  }

  let started = false;
  function start() { if (started) return; started = true; init(); }
  document.addEventListener('DOMContentLoaded', start);
  if (document.readyState !== 'loading') start();
})();