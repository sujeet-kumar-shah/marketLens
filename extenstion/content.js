// MarketLens 2.3 — Content script (sidebar UI)
//
// Rules this file follows:
//   * Every value shown is either read from the live page (with its provenance),
//     entered by the seller, or calculated from those — never invented.
//   * Missing data is displayed as missing with the reason, never as ₹0.
//   * All page-derived text is inserted with textContent (no HTML injection).
//   * Writes go through the background worker ('ml:patch' / 'ml:observe') so a
//     single context validates and repairs stored data.
//
// Depends on src modules loaded earlier in manifest.json.

(function () {
  'use strict';
  if (window.__marketLensV2Loaded) return;   // never inject a second sidebar
  window.__marketLensV2Loaded = true;

  const ML = window.MarketLens || {};
  const money = ML.money, dq = ML.dq, model = ML.model, rules = ML.rules,
        feeEngine = ML.fees, taxEngine = ML.tax, profit = ML.profit, recon = ML.recon,
        history = ML.history, competition = ML.competition,
        capture = ML.capture, charts = ML.charts,
        adapters = ML.adapters, storage = ML.storage;

  const SIDEBAR_ID = 'marketlens-sidebar-v2';
  const LAUNCHER_ID = 'marketlens-launcher-v2';
  const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'not', 'you', 'your',
    'size', 'colour', 'color', 'free', 'new', 'pack', 'pcs', 'piece', 'pieces', 'set', 'buy', 'online', 'india', 'best',
    'price', 'off', 'combo', 'kit', 'men', 'women', 'kids', 'boys', 'girls', 'unisex', 'cm', 'mm', 'inch', 'ml', 'kg', 'g']);

  // --------------------------------------------------------------- state
  let state = null;
  let loadIssues = [];
  let extraction = null;
  let product = null;
  let activeTab = 'listing';
  let sess = {};                 // seller inputs for the current product
  let lastComparables = null;    // in-memory result of the latest scan
  let lastObserveNote = null;    // what happened when we tried to record a price
  let isSearchCapturePage = false; // this page is a search / category listing page
  const ui = {};

  // --------------------------------------------------------------- helpers
  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function send(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, resp => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: 'No response from the extension worker.' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }
  function badge(text, tone) {
    return h('span', 'ml-badge ml-badge-' + (tone || 'muted'), text);
  }
  function provBadge(prov) {
    if (!prov) return badge('Not read', 'muted');
    return badge(dq.label(prov.status), dq.tone(prov.status));
  }
  function numFromInput(input) {
    const raw = (input.value || '').trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function rupeesInput(valuePaise, onChange) {
    const i = h('input', 'ml-input');
    i.type = 'number'; i.step = '0.01'; i.min = '0'; i.placeholder = '—';
    if (typeof valuePaise === 'number' && Number.isFinite(valuePaise)) i.value = String(money.fromPaise(valuePaise));
    i.addEventListener('change', () => onChange(money.toPaise(i.value)));
    return i;
  }
  function pctInput(value, onChange) {
    const i = h('input', 'ml-input');
    i.type = 'number'; i.step = '0.01'; i.min = '0'; i.placeholder = '—';
    if (typeof value === 'number' && Number.isFinite(value)) i.value = String(value);
    i.addEventListener('change', () => onChange(numFromInput(i)));
    return i;
  }
  function intInput(value, onChange) {
    const i = h('input', 'ml-input');
    i.type = 'number'; i.step = '1'; i.min = '0'; i.placeholder = '—';
    if (typeof value === 'number' && Number.isFinite(value)) i.value = String(value);
    i.addEventListener('change', () => onChange(numFromInput(i)));
    return i;
  }
  function textInput(value, onChange, placeholder) {
    const i = h('input', 'ml-input');
    i.type = 'text'; i.placeholder = placeholder || '';
    if (value) i.value = String(value);
    if (typeof onChange === 'function') i.addEventListener('change', () => onChange(i.value.trim() || null));
    return i;
  }
  function selectInput(options, value, onChange) {
    const s = h('select', 'ml-input');
    for (const opt of options) {
      const o = h('option', null, opt.label);
      o.value = opt.value === null || opt.value === undefined ? '' : String(opt.value);
      if (String(value === null || value === undefined ? '' : value) === o.value) o.selected = true;
      s.appendChild(o);
    }
    s.addEventListener('change', () => onChange(s.value === '' ? null : s.value));
    return s;
  }
  function field(labelText, inputEl, hintText) {
    const wrap = h('div', 'ml-field');
    wrap.appendChild(h('label', 'ml-field-label', labelText));
    wrap.appendChild(inputEl);
    if (hintText) wrap.appendChild(h('div', 'ml-hint', hintText));
    return wrap;
  }
  function moneyText(paise, opts) { return money.format(paise, opts); }
  function tsText(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }
  function section(title, note) {
    const s = h('div', 'ml-section');
    s.appendChild(h('h3', 'ml-section-title', title));
    if (note) s.appendChild(h('p', 'ml-note', note));
    return s;
  }
  function kv(label, value, tone) {
    const row = h('div', 'ml-kv');
    row.appendChild(h('span', 'ml-kv-label', label));
    row.appendChild(h('span', 'ml-kv-value' + (tone ? ' ml-' + tone : ''), value));
    return row;
  }
  function button(label, cls, onClick) {
    const b = h('button', 'ml-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function warnList(items, tone) {
    const ul = h('ul', 'ml-list ml-list-' + (tone || 'warn'));
    for (const item of items || []) ul.appendChild(h('li', null, item));
    return ul;
  }

  // --------------------------------------------------------------- init
  function unitKey() { return product ? model.unitKey(product) : null; }
  function currentRecord() {
    const key = unitKey();
    if (!key || !state.products) return {};
    return state.products[key] || {};
  }

  async function init() {
    try {
      const res = await storage.load();
      state = res.state; loadIssues = res.issues;
    } catch (e) {
      state = storage.defaults();
      loadIssues = ['Storage could not be read: ' + String(e && e.message || e)];
    }
    extraction = adapters.extractFor(document, location.href);
    product = extraction.product;
    isSearchCapturePage = capture.isSearchUrl(location.href);
    activeTab = isSearchCapturePage ? 'traffic' : 'listing';
    sess = Object.assign({}, currentRecord());
    sess.statement = Object.assign({}, sess.statement || {});
    buildShell();
    renderPanel();
    if (isSearchCapturePage) captureThisPage();
    else observeCurrentPage('listing_visit');
    watchInPageNavigation();
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  }

  function onStorageChanged(_, areaName) {
    if (areaName !== 'local') return;
    // Refresh the shared state in place; never clobber what the seller is typing.
    storage.load().then(res => {
      state = res.state;
      loadIssues = res.issues;
      if (activeTab === 'listing' || activeTab === 'watchlist' || activeTab === 'traffic' || activeTab === 'trend') renderPanel();
    }).catch(() => {});
  }
  function onRuntimeMessage(msg, sender, sendResponse) {
    if (msg && msg.type === 'ml:toggleSidebar') {
      toggleSidebar();
      sendResponse({ ok: true, visible: !ui.sidebar.classList.contains('ml-hidden') });
      return true;
    }
    return false;
  }
  function persistSess() {
    const key = unitKey();
    if (!key) return;
    send({ type: 'ml:patch', partial: { products: { [key]: sess } } });
  }
  async function observeCurrentPage(source) {
    if (!product || product.pricePaise === null || product.pricePaise === undefined) return;
    const key = unitKey();
    if (!key) return;
    const resp = await send({
      type: 'ml:observe',
      observation: {
        key,
        pricePaise: product.pricePaise,
        ts: product.observationTs || Date.now(),
        source: source || 'listing_visit',
        sellerName: product.sellerName || null,
        reviewCount: product.reviewCount === null || product.reviewCount === undefined ? null : product.reviewCount,
        title: product.title || null
      }
    });
    if (resp && resp.ok) {
      lastObserveNote = resp.stored
        ? 'Price recorded (' + (history.SOURCE_LABELS[source || 'listing_visit'] || 'observed') + ').'
        : 'Not stored again: ' + (resp.reason === 'same_price_within_window'
            ? 'same price already observed within the last 6 hours.'
            : String(resp.reason || 'duplicate observation'));
    } else {
      lastObserveNote = 'Could not store the observation: ' + ((resp && resp.error) || 'unknown error') + ' (nothing was invented).';
    }
    if (activeTab === 'listing' || activeTab === 'trend') renderPanel();
  }

  // --------------------------------------------------- search page capture
  /**
   * Record the search / category page the seller is LOOKING AT: positions as
   * the site showed them, prices only where readable. Stored under a
   * 'search:<marketplace>:<query>' key so product pages can report the
   * observed rank later. Nothing here is estimated.
   */
  async function captureThisPage() {
    try {
      const cap = capture.captureFromDocument(document, location.href);
      if (!cap.listings.length) {
        if (activeTab === 'traffic') renderPanel();
        return;
      }
      const key = 'search:' + cap.marketplace + ':' + String(cap.query || 'unlabelled').toLowerCase().slice(0, 80);
      const store = Object.assign({}, state.comparables);
      store[key] = cap;
      const res = await send({ type: 'ml:patch', partial: { comparables: store } });
      if (res && res.ok && res.state) state = res.state;
    } catch (e) {
      // Capture failed (layout change, DOM mid-load): nothing is stored, nothing is invented.
    }
    if (activeTab === 'traffic') renderPanel();
  }

  // --------------------------------------------------------------- shell
  // ------------------------------------------------------- header status
  function statusBadgePair() {
    if (isSearchCapturePage) return ['Search page — capturing listings', 'warn'];
    const map = {
      ok: ['Page read', 'ok'],
      partial: ['Partly read', 'warn'],
      dom_changed: ['Could not read page', 'bad'],
      unknown: ['Not read', 'muted']
    };
    return map[(extraction && extraction.extractionStatus) || 'unknown'] || map.unknown;
  }

  /** Re-label the header after an in-page navigation without rebuilding it. */
  function updateStatusLine() {
    if (!ui.statusLine) return;
    const mpLabel = product && product.marketplace ? rules.marketplace(product.marketplace).label : 'Unknown store';
    const sb = statusBadgePair();
    clear(ui.statusLine);
    ui.statusLine.appendChild(h('span', null, mpLabel + ' · '));
    ui.statusLine.appendChild(badge(sb[0], sb[1]));
  }

  function buildShell() {
    if (document.getElementById(SIDEBAR_ID)) return;

    const sidebar = h('div', 'ml-sidebar');
    sidebar.id = SIDEBAR_ID;

    const header = h('div', 'ml-header');
    const titleWrap = h('div', 'ml-title-wrap');
    const brand = h('div', 'ml-brand');
    brand.appendChild(h('span', 'ml-brand-dot', '◈'));
    brand.appendChild(h('span', 'ml-title', 'MarketLens'));
    titleWrap.appendChild(brand);
    const statusLine = h('div', 'ml-subtitle');
    ui.statusLine = statusLine;
    updateStatusLine();
    titleWrap.appendChild(statusLine);
    header.appendChild(titleWrap);
    const closeButton = button('', 'ml-close-btn', () => toggleSidebar(false));
    closeButton.title = 'Close MarketLens';
    closeButton.setAttribute('aria-label', 'Close MarketLens');
    const closeIcon = svgNode('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    closeIcon.appendChild(svgNode('path', {
      d: 'M6 6l12 12M18 6 6 18',
      fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round'
    }));
    closeButton.appendChild(closeIcon);
    header.appendChild(closeButton);
    ui.closeButton = closeButton;
    sidebar.appendChild(header);

    // Keep the frequent page actions reachable above the tab rail.
    const bar = h('div', 'ml-action-bar');
    bar.appendChild(button('Copy product ID', 'ml-btn-small', async () => {
      const id = product && product.productId;
      if (!id) { window.alert('No product id was readable on this page — nothing to copy.'); return; }
      try { await navigator.clipboard.writeText(String(id)); lastObserveNote = 'Copied product id ' + id; }
      catch (e) { window.prompt('Copy the product id (clipboard blocked):', String(id)); }
      renderPanel();
    }));
    ui.watchBtn = button('Add to Watchlist', 'ml-btn-small', async () => {
      await toggleWatchlist();
      renderPanel();
    });
    bar.appendChild(ui.watchBtn);
    sidebar.appendChild(bar);

    // Body: left icon rail + content panel.
    const body = h('div', 'ml-body');
    const rail = h('div', 'ml-rail');
    const tabs = [
      ['listing', '◉', 'Listing'],
      ['traffic', '⌕', 'Research'],
      ['trend', '↗', 'Price History'],
      ['settlement', '₹', 'Settlement Calculator'],
      ['profit', '%', 'Profit & Taxes'],
      ['watchlist', '☆', 'Watchlist']
    ];
    ui.tabButtons = {};
    for (const [id, icon, label] of tabs) {
      const b = h('button', 'ml-rail-btn');
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.appendChild(h('span', 'ml-rail-icon', icon));
      b.appendChild(h('span', 'ml-rail-label', label));
      b.addEventListener('click', () => { activeTab = id; renderPanel(); });
      ui.tabButtons[id] = b;
      rail.appendChild(b);
    }
    body.appendChild(rail);
    ui.panel = h('div', 'ml-panel');
    body.appendChild(ui.panel);
    sidebar.appendChild(body);

    const footer = h('div', 'ml-footer');
    footer.appendChild(h('span', null, 'Data stays in this browser · “—” = not observable on this page or not entered yet — add your own numbers in the fields and the popup.'));
    sidebar.appendChild(footer);

    document.body.appendChild(sidebar);
    ui.sidebar = sidebar;

    const launcher = h('button', 'ml-launcher');
    launcher.id = LAUNCHER_ID;
    launcher.type = 'button';
    launcher.title = 'Open MarketLens';
    launcher.setAttribute('aria-label', 'Open MarketLens');
    launcher.setAttribute('aria-controls', SIDEBAR_ID);
    launcher.setAttribute('aria-expanded', 'false');
    const bubble = svgNode('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    bubble.appendChild(svgNode('path', {
      d: 'M20 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.1A8 8 0 1 1 20 11.5Z',
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }));
    bubble.appendChild(svgNode('circle', { cx: 9, cy: 11.5, r: 1, fill: 'currentColor' }));
    bubble.appendChild(svgNode('circle', { cx: 12, cy: 11.5, r: 1, fill: 'currentColor' }));
    bubble.appendChild(svgNode('circle', { cx: 15, cy: 11.5, r: 1, fill: 'currentColor' }));
    launcher.appendChild(bubble);
    launcher.addEventListener('click', () => toggleSidebar());
    document.body.appendChild(launcher);
    ui.launcher = launcher;
    launcher.classList.add('ml-hidden');
    launcher.setAttribute('aria-expanded', 'true');

    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && ui.sidebar && !ui.sidebar.classList.contains('ml-hidden')) toggleSidebar(false);
    });
  }

  function toggleSidebar(force) {
    if (!ui.sidebar) return;
    const hide = typeof force === 'boolean' ? !force : !ui.sidebar.classList.contains('ml-hidden');
    ui.sidebar.classList.toggle('ml-hidden', hide);
    if (ui.launcher) ui.launcher.classList.toggle('ml-hidden', !hide);
    if (ui.launcher) ui.launcher.setAttribute('aria-expanded', String(!hide));
    const focusTarget = hide ? ui.launcher : ui.closeButton;
    if (focusTarget) focusTarget.focus();
  }

  // ------------------------------------------------- in-page navigation
  /**
   * Flipkart's current front end switches product and search pages without a
   * full reload, so this content script stays alive across those moves. Re-read
   * the page whenever the URL changes; otherwise a product opened from a search
   * page keeps the search page's "could not read" state indefinitely.
   */
  function watchInPageNavigation() {
    let href = location.href;
    setInterval(() => {
      if (location.href === href) return;
      href = location.href;
      rereadAfterNavigation(href);
    }, 700);
  }

  function rereadAfterNavigation(href) {
    const titleAtStart = document.title;
    let waited = 0;
    const waitForContent = () => {
      if (location.href !== href) return;                       // superseded by a newer move
      if (document.title === titleAtStart && waited < 3000) {
        waited += 400;
        setTimeout(waitForContent, 400);
        return;
      }
      // Give the framework one paint to swap the previous page's DOM out.
      setTimeout(() => applyPageRead(adapters.extractFor(document, href), href, 0), 500);
    };
    waitForContent();
  }

  function applyPageRead(next, href, attempt) {
    if (location.href !== href) return;
    const wasSearchPage = isSearchCapturePage;
    extraction = next;
    product = next.product;
    isSearchCapturePage = capture.isSearchUrl(href);
    if (wasSearchPage !== isSearchCapturePage && (activeTab === 'listing' || activeTab === 'traffic')) {
      activeTab = isSearchCapturePage ? 'traffic' : 'listing';
    }
    sess = Object.assign({}, currentRecord());
    sess.statement = Object.assign({}, sess.statement || {});
    if (!document.getElementById(SIDEBAR_ID)) buildShell();    // the app may replace <body>
    updateStatusLine();
    renderPanel();
    const retry = !isSearchCapturePage && next.extractionStatus === 'dom_changed' && attempt < 8;
    if (retry) {
      setTimeout(() => applyPageRead(adapters.extractFor(document, href), href, attempt + 1), 900);
      return;
    }
    if (isSearchCapturePage) captureThisPage();
    else observeCurrentPage('listing_visit');
  }

  function renderPanel() {
    if (!ui.panel) return;
    for (const [id, b] of Object.entries(ui.tabButtons)) {
      const active = id === activeTab;
      b.classList.toggle('ml-tab-active', active);
      b.setAttribute('aria-pressed', String(active));
    }
    if (ui.watchBtn) {
      const key = unitKey();
      const watched = !!(key && state.watchlist.find(w => w.key === key));
      ui.watchBtn.textContent = watched ? '✓ In Watchlist' : 'Add to Watchlist';
    }
    clear(ui.panel);
    if (activeTab === 'listing') renderListing();
    else if (activeTab === 'traffic') renderTraffic();
    else if (activeTab === 'trend') renderTrend();
    else if (activeTab === 'settlement') renderSettlement();
    else if (activeTab === 'profit') renderProfit();
    else if (activeTab === 'watchlist') renderWatchlist();
  }

  // --------------------------------------------------------------- overview
  const OBSERVED_FIELDS = [
    ['title', 'Title'], ['pricePaise', 'Selling price'], ['mrpPaise', 'MRP'], ['discountPct', 'Discount %'],
    ['rating', 'Rating'], ['reviewCount', 'Reviews'], ['sellerName', 'Seller'], ['fulfilment', 'Fulfilment'],
    ['actualWeightG', 'Weight (g)'], ['packedDimsCm', 'Packed dims'], ['stockStatus', 'Stock']
  ];

  // ------------------------------------------------------- chart rendering
  function svgNode(tag, attrs, textContent) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k of Object.keys(attrs || {})) node.setAttribute(k, String(attrs[k]));
    if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
    return node;
  }

  /**
   * Draw a series (line or step) with real axis labels and a soft fill.
   * Returns null when the chart module refuses to draw; the caller says why.
   */
  function svgChart(series, opts) {
    if (!series.ok) return null;
    const o = opts || {};
    const b = series.bounds;
    const svg = svgNode('svg', { viewBox: '0 0 ' + b.width + ' ' + b.height, class: 'ml-chart', preserveAspectRatio: 'xMidYMid meet' });
    for (const t of series.yTicks) {
      svg.appendChild(svgNode('line', { x1: b.padL, x2: b.width - b.padR, y1: t.y, y2: t.y, class: 'ml-grid-line' }));
      svg.appendChild(svgNode('text', { x: 2, y: t.y + 3, class: 'ml-axis-label' }, o.formatTick ? o.formatTick(t.value) : String(t.value)));
    }
    const parts = series.svgPoints.split(' ');
    const first = parts[0].split(','), last = parts[parts.length - 1].split(',');
    const baseY = b.height - b.padB;
    svg.appendChild(svgNode('polygon', { points: series.svgPoints + ' ' + last[0] + ',' + baseY + ' ' + first[0] + ',' + baseY, class: 'ml-fill' }));
    svg.appendChild(svgNode('polyline', { points: series.svgPoints, class: 'ml-line' }));
    for (const t of series.xTicks) {
      svg.appendChild(svgNode('text', { x: t.x, y: b.height - 8, class: 'ml-axis-label', 'text-anchor': 'middle' }, t.label));
    }
    return svg;
  }

  function chartCard(title, note, series, formatTick) {
    const card = section(title, note);
    const svg = svgChart(series, { formatTick });
    if (svg) card.appendChild(svg);
    else card.appendChild(h('p', 'ml-note', 'No chart: ' + series.reason + '.'));
    return card;
  }

  function observedSearchPositionCard() {
    const card = section('Observed search position',
      'Position from a search or category page you opened; this is not a sales rank.');
    const table = h('div', 'ml-table');
    const fsn = product.productId || null;
    const rank = fsn ? capture.findRankInCaptures(state.comparables, fsn) : null;
    const row = h('div', 'ml-table-row');
    row.appendChild(h('span', 'ml-table-label', 'Last captured'));
    row.appendChild(h('span', 'ml-table-value' + (rank ? '' : ' ml-muted'), rank
      ? '#' + rank.position + ' of ' + rank.sampleSize + (rank.query ? ' in “' + rank.query + '”' : '') + ' · ' + tsText(rank.observedAt)
      : 'No matching search capture yet'));
    table.appendChild(row);
    card.appendChild(table);
    return card;
  }

  // ------------------------------------------------- settlement calculator
  function donutSvg(segments, centerLabel, centerValue) {
    const svg = svgNode('svg', { viewBox: '0 0 200 200', class: 'ml-donut' });
    const r = 78, cx = 100, cy = 100, C = 2 * Math.PI * r;
    const total = segments.reduce((a, s) => a + Math.max(0, s.value || 0), 0);
    let acc = 0;
    for (const s of segments) {
      if (!s.value || s.value <= 0 || total <= 0) continue;
      const len = (s.value / total) * C;
      svg.appendChild(svgNode('circle', {
        cx, cy, r, fill: 'none', 'stroke-width': 26, stroke: s.color,
        'stroke-dasharray': (Math.round(len * 10) / 10) + ' ' + (Math.round((C - len) * 10) / 10),
        'stroke-dashoffset': -(Math.round(acc * 10) / 10),
        transform: 'rotate(-90 100 100)'
      }));
      acc += len;
    }
    svg.appendChild(svgNode('text', { x: 100, y: 94, class: 'ml-donut-center-label', 'text-anchor': 'middle' }, centerLabel));
    svg.appendChild(svgNode('text', { x: 100, y: 118, class: 'ml-donut-center-value', 'text-anchor': 'middle' }, centerValue));
    return svg;
  }

  function calcRow(name, sub, value, dotClass, total) {
    const row = h('div', 'ml-calc-row' + (total ? ' ml-calc-total' : ''));
    if (dotClass) row.appendChild(h('span', 'ml-dot ' + dotClass));
    const nameEl = h('span', 'ml-calc-name', name);
    if (sub) nameEl.appendChild(h('span', 'ml-calc-sub ml-muted', ' · ' + sub));
    row.appendChild(nameEl);
    row.appendChild(h('span', 'ml-calc-value', value));
    return row;
  }

  function calcSubRow(name, value) {
    const row = h('div', 'ml-calc-subrow');
    row.appendChild(h('span', 'ml-calc-subname', name));
    row.appendChild(h('span', 'ml-calc-value', value));
    return row;
  }

  function settlementCalculatorCard() {
    const card = section('Settlement Calculator',
      'One delivered order, split by your rate card. Nothing is adjusted to match a target.');
    const calc = { pricePaise: product.pricePaise };
    card.appendChild(field('Listing Price', rupeesInput(product.pricePaise, v => { calc.pricePaise = v; draw(); })));

    const out = h('div', 'ml-calc-out');
    function draw() {
      clear(out);
      if (calc.pricePaise === null || calc.pricePaise === undefined) {
        out.appendChild(h('p', 'ml-alert ml-alert-warn', 'Enter a listing price above — without a price there is nothing to split.'));
        return;
      }
      const feesResult = computeFeesAt(calc.pricePaise);
      const skip = ['logistics_forward', 'logistics_reverse', 'return_adjustment', 'gst_on_services'];
      const sumOf = list => list.reduce((a, c) => a + (c.amountPaise || 0), 0);
      const isKnown = list => list.length > 0 && list.every(c => c.status === 'computed');
      const valueOrDash = list => (isKnown(list) ? moneyText(sumOf(list)) : '—');

      const marketplaceComps = feesResult.components.filter(c => c.sign === 'charge' && skip.indexOf(c.feeType) === -1);
      const taxComps = feesResult.components.filter(c => c.feeType === 'gst_on_services');
      const logisticsComps = feesResult.components.filter(c => c.feeType === 'logistics_forward');
      const withheldComps = feesResult.components.filter(c => c.sign !== 'charge');

      const marketplaceFeePaise = sumOf(marketplaceComps.filter(c => c.status === 'computed'));
      const taxesPaise = sumOf(taxComps.filter(c => c.status === 'computed'));
      const logisticsPaise = sumOf(logisticsComps.filter(c => c.status === 'computed'));
      const netPaise = calc.pricePaise - marketplaceFeePaise - taxesPaise - logisticsPaise;
      // GST is levied on every taxable service fee, so it is only final once the
      // whole charge list is known. An incomplete list must never look settled.
      const taxesKnown = feesResult.complete && isKnown(taxComps);
      const feesKnown = isKnown(marketplaceComps) && taxesKnown;

      if (feesResult.complete) {
        out.appendChild(donutSvg([
          { value: marketplaceFeePaise, color: '#f8bbd0' },
          { value: taxesPaise, color: '#bbdefb' },
          { value: logisticsPaise, color: '#ffe0b2' },
          { value: netPaise, color: '#c8e6c9' }
        ], 'Listing Price', moneyText(calc.pricePaise)));
      } else {
        const dash = h('p', 'ml-dash', '—');
        dash.setAttribute('title', 'Some charges are unknown, so a full split would be guesswork. Add the missing rates in Profit & Taxes.');
        out.appendChild(dash);
      }

      out.appendChild(calcRow('Fees and Taxes', null, feesKnown ? moneyText(marketplaceFeePaise + taxesPaise) : '—', 'ml-dot-fees'));
      out.appendChild(calcSubRow('Marketplace Fee', valueOrDash(marketplaceComps)));
      out.appendChild(calcSubRow('Total Taxes', taxesKnown ? moneyText(taxesPaise) : '—'));
      out.appendChild(calcRow('Customer Logistics Fee', null, valueOrDash(logisticsComps), 'ml-dot-logistics'));
      if (withheldComps.length) out.appendChild(calcRow('TCS/TDS withheld', null, valueOrDash(withheldComps)));
      out.appendChild(calcRow('Est. Net Settlement', null, feesResult.complete ? moneyText(netPaise - sumOf(withheldComps)) : '—', 'ml-dot-net', true));

      if (!feesResult.complete) {
        out.appendChild(h('p', 'ml-alert ml-alert-warn',
          'Charge list incomplete (' + feesResult.missing.length + ' missing, ' + feesResult.conflicts.length + ' conflicts) — unresolved rows show —. Profit tab lists every unresolved charge.'));
      }
      out.appendChild(h('p', 'ml-note', 'This settlement is calculated as per your rate card.'));
    }
    draw();
    card.appendChild(out);
    return card;
  }

  function renderSettlement() {
    const wrap = ui.panel;
    wrap.appendChild(settlementCalculatorCard());
  }

  // ------------------------------------------------------ observed ratings
  function ratingGrowthCard() {
    const key = unitKey();
    const series = (key && state.observations[key]) ? state.observations[key] : [];
    const pts = series.filter(o => typeof o.reviewCount === 'number').map(o => ({ ts: o.ts, value: o.reviewCount }));
    const step = charts.buildStep(pts, { width: 520, height: 190 });
    return chartCard('Observed review-count history',
      'Recorded on repeat visits; changes between observations are not interpolated.',
      step, v => money.formatInt(v));
  }

  function renderListing() {
    const wrap = ui.panel;
    const card = section('Observed listing data',
      'Read once, at the moment this page loaded (' + tsText(product.observationTs) + '). Values the adapter could not find stay missing.');

    const table = h('div', 'ml-table');
    for (const [key, label] of OBSERVED_FIELDS) {
      const raw = product[key];
      let shown = null;
      if (key === 'pricePaise' || key === 'mrpPaise') shown = raw === null ? null : moneyText(raw);
      else if (key === 'discountPct') shown = raw === null ? null : money.formatPct(raw, { decimals: 1 });
      else if (key === 'packedDimsCm') shown = raw ? raw.l + ' × ' + raw.w + ' × ' + raw.h + ' cm' : null;
      else if (key === 'actualWeightG') shown = raw === null ? null : money.formatInt(raw) + ' g';
      else if (key === 'stockStatus') shown = raw === 'in_stock' ? 'In stock' : raw === 'out_of_stock' ? 'Out of stock' : (raw || null);
      else shown = raw === null || raw === undefined || raw === '' ? null : String(raw);
      const row = h('div', 'ml-table-row');
      row.appendChild(h('span', 'ml-table-label', label));
      const v = h('span', 'ml-table-value' + (shown === null ? ' ml-missing' : ''), shown === null ? 'not found' : shown);
      row.appendChild(v);
      row.appendChild(provBadge(product.fieldProvenance ? product.fieldProvenance[key] : null));
      table.appendChild(row);
    }
    card.appendChild(table);

    if (extraction.extractionStatus === 'dom_changed') {
      card.appendChild(h('p', 'ml-alert ml-alert-bad',
        'Neither title nor price could be read on this page. The site layout may have changed, or this is not a product page. MarketLens will not guess values.'));
    } else if (extraction.extractionStatus === 'partial') {
      card.appendChild(h('p', 'ml-alert ml-alert-warn',
        'Only part of the product could be read (title found: ' + (product.title ? 'yes' : 'no') + ', price found: ' +
        (product.pricePaise !== null ? 'yes' : 'no') + '). Fields marked “not found” are not part of any calculation.'));
    }
    if (extraction.warnings && extraction.warnings.length) card.appendChild(warnList(extraction.warnings, 'muted'));

    if (lastObserveNote) card.appendChild(h('p', 'ml-note', 'Price observation: ' + lastObserveNote));
    wrap.appendChild(card);
    wrap.appendChild(ratingGrowthCard());

    if (loadIssues && loadIssues.length) {
      const issueCard = section('Storage notes', 'From the last time stored data was read (migration or repair):');
      issueCard.appendChild(warnList(loadIssues, 'muted'));
      wrap.appendChild(issueCard);
    }
  }

  async function toggleWatchlist() {
    const key = unitKey();
    if (!key) return;
    const existing = state.watchlist.find(w => w.key === key);
    const next = existing ? state.watchlist.filter(w => w.key !== key)
      : state.watchlist.concat([{
          key,
          marketplace: product.marketplace || 'generic',
          productId: product.productId || null,
          title: product.title || null,
          url: location.href,
          image: null,
          addedAt: Date.now(),
          lastObservedAt: product.observationTs || null,
          lastPricePaise: product.pricePaise,
          fulfilment: product.fulfilment || null
        }]);
    await send({ type: 'ml:patch', partial: { watchlist: next } });
    const res = await send({ type: 'ml:getState' });
    if (res.ok) state = res.state;
  }

  // --------------------------------------------------------------- profit & settlement
  const BASE_INPUTS = [
    ['productCostPaise', 'Product cost (COGS) per unit', 'Your purchase or manufacturing cost. Leave blank until you know it — contribution is withheld, not guessed.'],
    ['packagingPaise', 'Packaging per unit', null],
    ['labelsPaise', 'Labels / inserts per unit', null],
    ['otherPrepPaise', 'Other per-unit prep costs', null],
    ['sellerPaidShippingPaise', 'Shipping you pay outside the marketplace fee (per order)', null],
    ['otherVariablePaise', 'Other variable cost per order', null]
  ];
  const RETURN_INPUTS = [
    ['returnRatePct', 'Return rate %', 'Your observed or expected return rate. Leave blank to exclude returns entirely.']
  ];
  function renderProfit() {
    const wrap = ui.panel;
    wrap.appendChild(profitCostsCard());
    wrap.appendChild(feeRuleCard());
    wrap.appendChild(profitResultCard());
    wrap.appendChild(returnCard());
    wrap.appendChild(solverCard());
    wrap.appendChild(discountCard());
    wrap.appendChild(adsCard());
    wrap.appendChild(forecastCard());
    wrap.appendChild(reconciliationCard());
  }

  function profitCostsCard() {
    const card = section('Your costs (per unit / per order)',
      'Everything here is your input and is stored only in this browser. Blank means unknown — it is never treated as zero.');
    for (const [key, label, hint] of BASE_INPUTS) {
      card.appendChild(field(label, rupeesInput(sess[key], v => { sess[key] = v; persistSess(); renderPanel(); }), hint));
    }
    return card;
  }

  function feeContext(pricePaise) {
    const dims = (sess.dimsL || sess.dimsW || sess.dimsH)
      ? { l: Number(sess.dimsL) || null, w: Number(sess.dimsW) || null, h: Number(sess.dimsH) || null }
      : null;
    return {
      marketplace: product.marketplace || 'generic',
      category: sess.category || product.category || null,
      subcategory: sess.subcategory || product.subcategory || null,
      fulfilment: sess.fulfilment || product.fulfilment || null,
      zone: sess.zone || null,
      pricePaise: pricePaise === null || pricePaise === undefined ? product.pricePaise : pricePaise,
      sellerFundedDiscountPaise: 0,
      actualWeightG: sess.weightG !== undefined && sess.weightG !== null ? sess.weightG : (product.actualWeightG || null),
      packedDimsCm: dims || product.packedDimsCm || null,
      quantity: sess.quantity || 1
    };
  }
  function buildRuleList() {
    return rules.structuralRules().concat(state.feeRules || []);
  }
  function computeFeesAt(pricePaise) {
    return feeEngine.computeFees(feeContext(pricePaise), buildRuleList());
  }
  function profitInput(pricePaise, feesResult) {
    const input = {
      pricePaise: pricePaise,
      sellerFundedDiscountPaise: 0,
      productCostPaise: sess.productCostPaise === undefined ? null : sess.productCostPaise,
      packagingPaise: sess.packagingPaise === undefined ? null : sess.packagingPaise,
      labelsPaise: sess.labelsPaise === undefined ? null : sess.labelsPaise,
      otherPrepPaise: sess.otherPrepPaise === undefined ? null : sess.otherPrepPaise,
      sellerPaidShippingPaise: sess.sellerPaidShippingPaise === undefined ? null : sess.sellerPaidShippingPaise,
      otherVariablePaise: sess.otherVariablePaise === undefined ? null : sess.otherVariablePaise,
      returnRatePct: sess.returnRatePct === undefined ? null : sess.returnRatePct,
      lossPerReturnPaise: sess.lossPerReturnPaise === undefined ? null : sess.lossPerReturnPaise,
      rtoRatePct: sess.rtoRatePct === undefined ? null : sess.rtoRatePct,
      lossPerRtoPaise: sess.lossPerRtoPaise === undefined ? null : sess.lossPerRtoPaise,
      adsPerOrderPaise: sess.adsPerOrderPaise === undefined ? null : sess.adsPerOrderPaise,
      fixedMonthlyPaise: sess.fixedMonthlyPaise === undefined ? null : sess.fixedMonthlyPaise,
      ordersPerMonth: sess.ordersPerMonth === undefined ? null : sess.ordersPerMonth,
      taxConfig: state.taxConfig
    };
    if (feesResult) input.fees = feesResult;
    else if (pricePaise !== null && pricePaise !== undefined) input.feeAtPrice = computeFeesAt;
    return input;
  }

  function feeRuleCard() {
    const mp = product.marketplace || 'generic';
    const card = section('Your fee rate card — ' + rules.marketplace(mp).label,
      'MarketLens does not ship rate numbers. Enter what your seller panel / rate card says; until a fee has a rate, it is reported as missing.');

    const mine = (state.feeRules || []).filter(r => r.marketplace === mp);
    const list = h('div', 'ml-rules');
    if (!mine.length) {
      list.appendChild(h('p', 'ml-note', 'No rates entered for ' + rules.marketplace(mp).label + ' yet.'));
    }
    for (const rule of mine) {
      const row = h('div', 'ml-rule-row');
      const left = h('div', 'ml-rule-main');
      left.appendChild(h('span', 'ml-rule-name', rules.FEE_TYPES[rule.feeType] ? rules.FEE_TYPES[rule.feeType].label : rule.feeType));
      left.appendChild(h('span', 'ml-rule-desc', rules.describe(rule) +
        (rule.category ? ' · category ' + rule.category : '') +
        (rule.fulfilment ? ' · ' + rule.fulfilment : '') +
        (rule.weightBandG ? ' · ' + (rule.weightBandG.minG / 1000) + '–' + (rule.weightBandG.maxG === null || rule.weightBandG.maxG === undefined ? '∞' : rule.weightBandG.maxG / 1000) + ' kg' : '') +
        (rule.perKgBeyondPaise !== null && rule.perKgBeyondPaise !== undefined ? ' + ' + moneyText(rule.perKgBeyondPaise) + '/kg beyond' : '')));
      const fresh = dq.freshness(rule.lastVerifiedAt);
      left.appendChild(h('span', 'ml-rule-fresh ' + 'ml-' + dq.tone(fresh.status), fresh.note));
      row.appendChild(left);
      row.appendChild(badge('your rate', 'ok'));
      row.appendChild(button('Delete', 'ml-btn-small', async () => {
        if (!window.confirm('Delete this rule? Calculations that used it will report the fee as missing.')) return;
        const next = state.feeRules.filter(r => r.id !== rule.id);
        await send({ type: 'ml:patch', partial: { feeRules: next } });
        const res = await send({ type: 'ml:getState' });
        if (res.ok) state = res.state;
        renderPanel();
      }));
      list.appendChild(row);
    }
    card.appendChild(list);

    // Add-rule form
    const form = h('div', 'ml-rule-form');
    const draft = {};
    const feeTypeOptions = Object.keys(rules.FEE_TYPES).map(k => ({ value: k, label: rules.FEE_TYPES[k].label }));
    form.appendChild(field('Fee type', selectInput(feeTypeOptions, 'commission', v => { draft.feeType = v; })));
    form.appendChild(field('Category (optional)', textInput(null, v => { draft.category = v; }, 'e.g. electronics')));
    form.appendChild(field('Rate % (for percentage fees)', pctInput(null, v => { draft.ratePct = v; })));
    form.appendChild(field('Fixed amount ₹', rupeesInput(null, v => { draft.fixedPaise = v; })));
    form.appendChild(field('Minimum fee ₹ (optional)', rupeesInput(null, v => { draft.minFeePaise = v; })));
    form.appendChild(field('Maximum fee ₹ (optional)', rupeesInput(null, v => { draft.maxFeePaise = v; })));
    form.appendChild(field('Weight band from (g)', intInput(null, v => { draft.bandMinG = v; })));
    form.appendChild(field('Weight band to (g, blank = open)', intInput(null, v => { draft.bandMaxG = v; })));
    form.appendChild(field('₹ per kg beyond the band', rupeesInput(null, v => { draft.perKgBeyondPaise = v; })));
    form.appendChild(field('Note (where the number came from)', textInput(null, v => { draft.note = v; }, 'e.g. “seller panel rate card, checked 19 Oct”')));
    form.appendChild(button('Add rule (you confirm this rate)', '', async () => {
      const rule = rules.makeRule({
        marketplace: mp,
        feeType: draft.feeType || 'commission',
        category: draft.category || null,
        ratePct: draft.ratePct === undefined ? null : draft.ratePct,
        fixedPaise: draft.fixedPaise === undefined ? null : draft.fixedPaise,
        minFeePaise: draft.minFeePaise === undefined ? null : draft.minFeePaise,
        maxFeePaise: draft.maxFeePaise === undefined ? null : draft.maxFeePaise,
        weightBandG: draft.bandMinG === undefined || draft.bandMinG === null ? null
          : { minG: draft.bandMinG, maxG: draft.bandMaxG === undefined ? null : draft.bandMaxG },
        perKgBeyondPaise: draft.perKgBeyondPaise === undefined ? null : draft.perKgBeyondPaise,
        basis: draft.feeType === 'logistics_forward' || draft.feeType === 'logistics_reverse' || draft.feeType === 'weight_handling' ? 'weight' : undefined,
        divisor: 5000,
        provenance: 'seller',
        verification: 'seller_confirmed',
        note: draft.note || null
      });
      const next = (state.feeRules || []).concat([rule]);
      await send({ type: 'ml:patch', partial: { feeRules: next } });
      const res = await send({ type: 'ml:getState' });
      if (res.ok) state = res.state;
      renderPanel();
    }));
    card.appendChild(form);
    return card;
  }

  function profitResultCard() {
    const card = section('Settlement & contribution (one delivered unit)', null);
    const price = product.pricePaise;
    if (price === null || price === undefined) {
      card.appendChild(h('p', 'ml-alert ml-alert-bad', 'No selling price could be read from this page, so nothing can be computed. Enter the price in a marketplace page or use the price history tab.'));
      return card;
    }
    const feesResult = computeFeesAt(price);
    const result = profit.unitEconomics(profitInput(price, feesResult));

    // Fee components
    card.appendChild(h('h4', 'ml-subtitle-2', 'Marketplace charges (rule by rule)'));
    const feeTable = h('div', 'ml-table');
    for (const c of feesResult.components) {
      const row = h('div', 'ml-table-row ml-3col');
      row.appendChild(h('span', 'ml-table-label', c.label || c.feeType));
      row.appendChild(h('span', 'ml-table-value' + (c.status === 'computed' ? '' : ' ml-missing'),
        c.status === 'computed' ? moneyText(c.amountPaise) : (c.reason || c.status)));
      const provTone = c.provenance === 'seller' ? 'ok' : 'muted';
      const provText = c.provenance === 'seller' ? 'your rate (' + c.ruleId + ')' : (c.status === 'computed' ? 'structural rule — verify' : 'no rule');
      row.appendChild(badge(provText, provTone));
      feeTable.appendChild(row);
      if (c.status === 'computed' && c.detail && c.detail.caveats && c.detail.caveats.length) {
        feeTable.appendChild(h('div', 'ml-subnote', c.detail.caveats.join(' · ')));
      }
    }
    card.appendChild(feeTable);
    if (!feesResult.complete) {
      card.appendChild(h('p', 'ml-alert ml-alert-warn',
        'The charge list is incomplete (' + feesResult.missing.length + ' missing, ' + feesResult.conflicts.length + ' conflicts). Totals below exclude unresolved charges — the settlement shown would be optimistic.'));
    }
    for (const conflict of feesResult.conflicts) card.appendChild(h('p', 'ml-alert ml-alert-bad', conflict.message));

    // Cash view
    card.appendChild(h('h4', 'ml-subtitle-2', 'Cash settlement (what reaches your bank)'));
    card.appendChild(kv('Gross in (price − your funded discount)', moneyText(result.cash.grossInPaise)));
    card.appendChild(kv('Marketplace charges (incl. GST on services)', moneyText(result.cash.marketplaceChargesPaise)));
    card.appendChild(kv('TCS/TDS withheld', moneyText(result.cash.withheldPaise)));
    card.appendChild(kv('Expected settlement', moneyText(result.cash.settlementPaise) + '  ' + (result.readiness.settlementKnown ? '' : ' (incomplete)')));
    card.appendChild(h('p', 'ml-note', result.cash.note + ' COGS and your other costs are NOT deducted here.'));

    // Business view
    card.appendChild(h('h4', 'ml-subtitle-2', 'Business view (contribution)'));
    card.appendChild(kv('Net sales revenue (excl. output GST where applicable)', moneyText(result.business.netSalesRevenuePaise)));
    card.appendChild(kv('Marketplace cost (ITC-aware)', moneyText(result.business.marketplaceCostPaise)));
    card.appendChild(kv('Contribution before advertising', moneyText(result.business.contributionBeforeAdsPaise),
      result.business.contributionBeforeAdsPaise === null ? 'bad' : result.business.contributionBeforeAdsPaise >= 0 ? 'ok' : 'bad'));
    card.appendChild(kv('Contribution after advertising', moneyText(result.business.contributionAfterAdsPaise)));
    card.appendChild(kv('Contribution margin (on price)', money.formatPct(result.business.contributionMarginOnPricePct)));
    card.appendChild(kv('ROI on product cost', money.formatPct(result.business.roiOnProductCostPct)));
    if (result.business.operatingProfitMonthlyPaise !== null) {
      card.appendChild(kv('Operating profit / month (after fixed costs)', moneyText(result.business.operatingProfitMonthlyPaise)));
    }
    if (result.business.profitAfterIncomeTaxMonthlyPaise !== null) {
      card.appendChild(kv('After income tax (your flat rate — rough)', moneyText(result.business.profitAfterIncomeTaxMonthlyPaise)));
    }
    card.appendChild(h('p', 'ml-note', 'Contribution is not “net profit”: it excludes fixed costs, income tax timing and anything you have not entered.'));

    if (result.missing.length) {
      card.appendChild(h('p', 'ml-alert ml-alert-warn', 'Missing inputs (each one blocks part of the calculation):'));
      card.appendChild(warnList(result.missing.map(m => m.label + ' — ' + m.why), 'warn'));
    }
    if (result.caveats.length) {
      card.appendChild(h('p', 'ml-note', 'Notes & caveats:'));
      card.appendChild(warnList(result.caveats, 'muted'));
    }
    return card;
  }

  function solverCard() {
    const card = section('Target price solver',
      'Finds the lowest selling price that meets your goal. Fees are recalculated at every candidate price (percentage fees, slabs and GST included), then the answer is verified by re-evaluating it.');
    const goalSel = selectInput([
      { value: 'breakeven', label: 'Break even (contribution ≥ ₹0)' },
      { value: 'profit', label: 'Target contribution ₹ per unit' },
      { value: 'margin', label: 'Target contribution margin % of price' },
      { value: 'roi', label: 'Target ROI % on product cost' }
    ], 'breakeven', () => {});
    const valueField = field('Goal value (₹ or %)', rupeesInput(null, () => {}));
    card.appendChild(field('Goal', goalSel));
    card.appendChild(valueField);
    const out = h('div', 'ml-solver-out');
    card.appendChild(button('Find price', '', () => {
      clear(out);
      if (sess.productCostPaise === undefined || sess.productCostPaise === null) {
        out.appendChild(h('p', 'ml-alert ml-alert-warn', 'Enter the product cost first — without it, contribution is not computable and no price can be "solved".'));
        return;
      }
      const type = goalSel.value;
      const valueInput = valueField.querySelector('input');
      const goalValue = numFromInput(valueInput);
      const goal = { type, value: type === 'profit' ? money.toPaise(valueInput.value) : goalValue };
      const baseline = Math.max(product.pricePaise || 10000, 1000);
      const res = profit.targetPrice(profitInput(baseline, null), goal);
      if (!res.feasible) {
        out.appendChild(h('p', 'ml-alert ml-alert-bad', 'No price up to ' + moneyText(res.ceilingPaise) + ' reaches that goal. ' + (res.reason || '') +
          ' Best value reached: ' + (res.bestValueAtCeiling === null || res.bestValueAtCeiling === undefined ? 'not computable' : String(Math.round(res.bestValueAtCeiling * 100) / 100)) + '.'));
        out.appendChild(h('p', 'ml-note', 'Nothing was invented: the solver reports the best it found and where it stopped.'));
        return;
      }
      out.appendChild(kv('Lowest price meeting the goal', moneyText(res.pricePaise), 'ok'));
      if (res.result) {
        out.appendChild(kv('Contribution there', moneyText(res.result.business.contributionBeforeAdsPaise)));
        out.appendChild(kv('Margin there', money.formatPct(res.result.business.contributionMarginOnPricePct)));
        out.appendChild(kv('Settlement there', moneyText(res.result.cash.settlementPaise)));
      }
      out.appendChild(h('p', 'ml-note', res.note || 'Verified by re-evaluating the metric at the solved price.'));
      const at = computeFeesAt(res.pricePaise);
      if (!at.complete) out.appendChild(h('p', 'ml-alert ml-alert-warn', 'Note: the charge list is incomplete at this price (' + at.missing.length + ' unresolved), so the solved price may be too low.'));
    }));
    card.appendChild(out);
    return card;
  }

  function discountCard() {
    const card = section('Discount simulator',
      'Each row re-runs the full fee + tax + profit stack at the discounted price. Platform-funded discounts are not assumed.');
    const custom = rupeesInput(null, () => {});
    const out = h('div', 'ml-disc-out');
    const actions = h('div', 'ml-actions');
    actions.appendChild(button('Simulate 5 / 10 / 15 / 20 % off', '', () => {
      clear(out);
      renderDiscountRows(out, [5, 10, 15, 20]);
    }));
    actions.appendChild(button('+ custom %', '', () => {
      const pct = numFromInput(custom);
      clear(out);
      renderDiscountRows(out, pct === null ? [5, 10, 15, 20] : [5, 10, 15, 20, pct]);
    }));
    card.appendChild(actions);
    card.appendChild(out);
    return card;
  }
  function renderDiscountRows(out, discounts) {
    if (product.pricePaise === null || product.pricePaise === undefined) {
      out.appendChild(h('p', 'ml-alert ml-alert-warn', 'No current price to discount from.'));
      return;
    }
    const sim = profit.discountScenarios({
      basis: 'current',
      currentPricePaise: product.pricePaise,
      discounts,
      evaluate: p => profit.unitEconomics(profitInput(p, computeFeesAt(p)))
    });
    const table = h('div', 'ml-table');
    const head = h('div', 'ml-table-row ml-4col ml-table-head');
    head.appendChild(h('span', 'ml-table-label', 'Discount'));
    head.appendChild(h('span', 'ml-table-value', 'Price'));
    head.appendChild(h('span', 'ml-table-value', 'Charges'));
    head.appendChild(h('span', 'ml-table-value', 'Contribution'));
    table.appendChild(head);
    for (const r of sim.rows) {
      const row = h('div', 'ml-table-row ml-4col');
      row.appendChild(h('span', 'ml-table-label', r.discountPct + '%'));
      row.appendChild(h('span', 'ml-table-value', moneyText(r.finalPricePaise)));
      row.appendChild(h('span', 'ml-table-value', moneyText(r.marketplaceChargesPaise)));
      row.appendChild(h('span', 'ml-table-value' + (r.profitable === false ? ' ml-bad' : r.profitable === true ? ' ml-ok' : ''),
        moneyText(r.contributionBeforeAdsPaise) + (r.contributionMarginPct === null ? '' : ' (' + money.formatPct(r.contributionMarginPct) + ')')));
      table.appendChild(row);
    }
    out.appendChild(table);
    if (sim.warning) out.appendChild(h('p', 'ml-alert ml-alert-bad', sim.warning));
    out.appendChild(h('p', 'ml-note', sim.caveat));
  }

  function returnCard() {
    const card = section('Return Rate',
      'Your own rate only — Flipkart’s vertical averages are internal. Enter a rate to see the per-order impact; if you enter a rate but no loss per return, nothing is modelled and the missing input is listed.');
    card.appendChild(field('Return rate %', pctInput(sess.returnRatePct, v => { sess.returnRatePct = v; persistSess(); renderPanel(); }), RETURN_INPUTS[0][2]));
    const suggestRow = h('div', 'ml-actions');
    suggestRow.appendChild(button('Suggest loss per return', '', () => {
      const feesResult = computeFeesAt(product.pricePaise);
      const s = profit.suggestReturnLoss(feesResult, sess.packagingPaise || 0);
      if (s.valuePaise === null) {
        window.alert('No reverse-logistics rule exists yet for this marketplace, so MarketLens cannot suggest a loss. Enter your own value.');
        return;
      }
      window.alert(s.valuePaise === null ? 'No suggestion available.' : 'Suggestion: ' + moneyText(s.valuePaise) + '\n\n' + s.basis);
    }));
    card.appendChild(suggestRow);
    card.appendChild(field('Loss per returned order ₹', rupeesInput(sess.lossPerReturnPaise, v => { sess.lossPerReturnPaise = v; persistSess(); renderPanel(); })));
    card.appendChild(field('RTO rate %', pctInput(sess.rtoRatePct, v => { sess.rtoRatePct = v; persistSess(); renderPanel(); })));
    card.appendChild(field('Loss per RTO order ₹', rupeesInput(sess.lossPerRtoPaise, v => { sess.lossPerRtoPaise = v; persistSess(); renderPanel(); })));

    const out = h('div', 'ml-return-out');
    const price = product.pricePaise;
    if (price !== null) {
      const result = profit.unitEconomics(profitInput(price, computeFeesAt(price)));
      const baseExReturn = result.business.contributionBeforeAdsPaise === null || result.components.returnProvisionPaise === null
        ? null : result.business.contributionBeforeAdsPaise + result.components.returnProvisionPaise;
      const s = profit.returnSensitivity({
        contributionBeforeAdsExReturnPaise: baseExReturn,
        lossPerReturnPaise: sess.lossPerReturnPaise === undefined ? null : sess.lossPerReturnPaise,
        lossPerRtoPaise: sess.lossPerRtoPaise === undefined ? null : sess.lossPerRtoPaise,
        rtoRatePct: sess.rtoRatePct === undefined ? null : sess.rtoRatePct,
        rates: [0, 2, 5, 8, 12, 20]
      });
      const table = h('div', 'ml-table');
      const head = h('div', 'ml-table-row ml-3col ml-table-head');
      head.appendChild(h('span', 'ml-table-label', 'Return %'));
      head.appendChild(h('span', 'ml-table-value', 'Provision'));
      head.appendChild(h('span', 'ml-table-value', 'Contribution'));
      table.appendChild(head);
      for (const r of s.rows) {
        const row = h('div', 'ml-table-row ml-3col');
        row.appendChild(h('span', 'ml-table-label', String(r.returnRatePct) + '% (RTO ' + String(r.rtoRatePct) + '%)'));
        row.appendChild(h('span', 'ml-table-value', moneyText(r.provisionPaise)));
        row.appendChild(h('span', 'ml-table-value' + (r.contributionBeforeAdsPaise !== null && r.contributionBeforeAdsPaise < 0 ? ' ml-bad' : ''),
          moneyText(r.contributionBeforeAdsPaise)));
        table.appendChild(row);
      }
      out.appendChild(table);
      if (s.missing.length) out.appendChild(warnList(s.missing.map(m => m.label + ' — ' + m.why), 'warn'));
      out.appendChild(h('p', 'ml-note', s.caveat));
    }
    card.appendChild(out);
    return card;
  }

  function adsCard() {
    const card = section('Advertising (from your ad platform numbers)',
      'MarketLens never invents attributed sales. Enter the numbers your ad platform reports.');
    const adsDraft = { spendPaise: null, attributedRevenuePaise: null, attributedOrders: null, clicks: null };
    card.appendChild(field('Spend (period) ₹', rupeesInput(null, v => { adsDraft.spendPaise = v; })));
    card.appendChild(field('Attributed sales ₹ (ad platform report)', rupeesInput(null, v => { adsDraft.attributedRevenuePaise = v; })));
    card.appendChild(field('Attributed orders', intInput(null, v => { adsDraft.attributedOrders = v; })));
    card.appendChild(field('Clicks (optional)', intInput(null, v => { adsDraft.clicks = v; })));
    const out = h('div', 'ml-ads-out');
    card.appendChild(button('Calculate ACOS / ROAS', '', () => {
      clear(out);
      const price = product.pricePaise;
      let contributionPerOrder = null;
      if (price !== null) {
        const r = profit.unitEconomics(profitInput(price, computeFeesAt(price)));
        contributionPerOrder = r.business.contributionBeforeAdsPaise;
      }
      const m = profit.advertisingMetrics(Object.assign({ contributionBeforeAdsPerOrderPaise: contributionPerOrder }, adsDraft));
      out.appendChild(kv('ACOS', money.formatPct(m.acosPct)));
      out.appendChild(kv('ROAS', m.roas === null ? '—' : m.roas.toFixed(2) + '×'));
      out.appendChild(kv('Cost per attributed order', moneyText(m.costPerOrderPaise)));
      out.appendChild(kv('Cost per click', moneyText(m.costPerClickPaise)));
      out.appendChild(kv('Break-even ROAS', m.breakEvenRoas === null ? '—' : m.breakEvenRoas.toFixed(2) + '×'));
      out.appendChild(kv('Break-even ACOS', money.formatPct(m.breakEvenAcosPct)));
      if (m.notes.length) out.appendChild(warnList(m.notes, 'muted'));
      if (m.missing.length) out.appendChild(warnList(m.missing.map(x => x.label + ' — ' + x.why), 'warn'));
    }));
    card.appendChild(out);
    return card;
  }

  function forecastCard() {
    const card = section('Monthly forecast',
      'Scenarios are stated multipliers on YOUR entered volume — not a prediction from sales history.');
    const out = h('div', 'ml-forecast-out');
    card.appendChild(field('Orders per month', intInput(sess.ordersPerMonth, v => { sess.ordersPerMonth = v; persistSess(); })));
    card.appendChild(field('Fixed monthly costs ₹', rupeesInput(sess.fixedMonthlyPaise, v => { sess.fixedMonthlyPaise = v; persistSess(); })));
    card.appendChild(button('Forecast', '', () => {
      clear(out);
      const price = product.pricePaise;
      if (price === null) { out.appendChild(h('p', 'ml-alert ml-alert-warn', 'No current price — cannot forecast.')); return; }
      const unitInput = profitInput(price, computeFeesAt(price));
      const f = profit.monthlyForecast({
        ordersPerMonth: sess.ordersPerMonth === undefined ? null : sess.ordersPerMonth,
        returnRatePct: sess.returnRatePct === undefined ? null : sess.returnRatePct,
        rtoRatePct: sess.rtoRatePct === undefined ? null : sess.rtoRatePct,
        unitAt: () => profit.unitEconomics(unitInput)
      });
      if (f.missing && f.missing.length) { out.appendChild(warnList(f.missing.map(m => m.label + ' — ' + m.why), 'warn')); return; }
      const table = h('div', 'ml-table');
      const head = h('div', 'ml-table-row ml-3col ml-table-head');
      head.appendChild(h('span', 'ml-table-label', 'Scenario'));
      head.appendChild(h('span', 'ml-table-value', 'Orders / delivered'));
      head.appendChild(h('span', 'ml-table-value', 'Operating profit'));
      table.appendChild(head);
      for (const r of f.rows) {
        const row = h('div', 'ml-table-row ml-3col');
        row.appendChild(h('span', 'ml-table-label', r.scenario + (r.note ? ' · ' + r.note : '')));
        row.appendChild(h('span', 'ml-table-value', money.formatInt(r.orders) + ' / ' + money.formatInt(r.deliveredOrders)));
        row.appendChild(h('span', 'ml-table-value' + (r.operatingProfitPaise !== null && r.operatingProfitPaise < 0 ? ' ml-bad' : ''), moneyText(r.operatingProfitPaise)));
        table.appendChild(row);
      }
      out.appendChild(table);
      out.appendChild(h('p', 'ml-note', f.caveat));
    }));
    card.appendChild(out);
    return card;
  }

  function reconciliationCard() {
    const card = section('Statement reconciliation (₹797-style checks)',
      'Type what your settlement statement shows. MarketLens compares the arithmetic of your components against the claimed settlement and NEVER adjusts a number to force agreement.');
    const st = sess.statement;
    const mk = (label, key, hint) => field(label, rupeesInput(st[key], v => { st[key] = v; sess.statement = st; persistSess(); }), hint);
    card.appendChild(mk('Marketplace fee ₹', 'feePaise'));
    card.appendChild(mk('Taxes shown on statement ₹', 'taxPaise'));
    card.appendChild(mk('Logistics fee ₹', 'logisticsPaise'));
    card.appendChild(mk('Other charges ₹', 'otherPaise'));
    card.appendChild(mk('Settlement amount your statement shows ₹', 'claimedSettlementPaise'));
    card.appendChild(field('Tolerance ₹ (rounding allowance)', rupeesInput(st.tolerancePaise === undefined ? state.settings.reconciliationTolerancePaise : st.tolerancePaise,
      v => { st.tolerancePaise = v; sess.statement = st; persistSess(); })));
    const out = h('div', 'ml-recon-out');
    const actions = h('div', 'ml-actions');
    actions.appendChild(button('Check against statement', '', () => {
      clear(out);
      const price = product.pricePaise;
      if (price === null) { out.appendChild(h('p', 'ml-alert ml-alert-warn', 'No selling price — enter the price your statement is for.')); return; }
      const components = [
        { label: 'Marketplace fee', kind: 'fee', sign: 'charge', amountPaise: st.feePaise === undefined ? null : st.feePaise },
        { label: 'Taxes shown', kind: 'tax', sign: 'charge', amountPaise: st.taxPaise === undefined ? null : st.taxPaise },
        { label: 'Logistics', kind: 'logistics', sign: 'charge', amountPaise: st.logisticsPaise === undefined ? null : st.logisticsPaise },
        { label: 'Other charges', kind: 'other', sign: 'charge', amountPaise: st.otherPaise === undefined ? null : st.otherPaise }
      ];
      const r = recon.reconcile({
        pricePaise: price,
        components,
        claimedSettlementPaise: st.claimedSettlementPaise === undefined ? null : st.claimedSettlementPaise,
        tolerancePaise: st.tolerancePaise === undefined ? state.settings.reconciliationTolerancePaise : st.tolerancePaise
      });
      out.appendChild(kv('Expected from your components', moneyText(r.expectedSettlementPaise)));
      out.appendChild(kv('Claimed on statement', moneyText(r.claimedSettlementPaise)));
      out.appendChild(kv('Difference', r.differencePaise === null ? 'not checked' : moneyText(r.differencePaise), r.agreement === 'exact' ? 'ok' : r.agreement === 'mismatch' ? 'bad' : 'warn'));
      for (const f of r.flags) {
        out.appendChild(h('p', 'ml-alert ml-alert-' + (f.level === 'bad' ? 'bad' : f.level === 'warn' ? 'warn' : 'muted'), f.message));
      }
      out.appendChild(h('p', 'ml-note', r.disclaimer));
    }));
    actions.appendChild(button('Use computed charges', '', () => {
      const feesResult = computeFeesAt(product.pricePaise);
      for (const c of feesResult.components) {
        if (c.status !== 'computed') continue;
        if (c.feeType === 'gst_on_services') st.taxPaise = c.amountPaise;
        else if (c.feeType === 'logistics_forward') st.logisticsPaise = c.amountPaise;
        else if (c.feeType === 'logistics_reverse' || c.feeType === 'return_adjustment') continue;
        else if (c.sign === 'charge') st.feePaise = (st.feePaise || 0) + c.amountPaise;
      }
      sess.statement = st;
      persistSess();
      renderPanel();
    }));
    card.appendChild(actions);
    card.appendChild(out);
    return card;
  }

  // ---------------------------------------------- comparable page scanning
  function comparablesScanCard() {
    const card = section('Comparable listings on this page',
      'Scans the listings this page ACTUALLY shows — one page, one point in time. Search / category pages work best; product pages usually show only accessories.');
    const actions = h('div', 'ml-actions');
    actions.appendChild(button('Scan this page', '', () => {
      const scan = adapters.scanComparables(document, location.href);
      const analyzed = competition.analyzeComparables({
        listings: scan.listings,
        observedAt: Date.now(),
        source: document.title || location.hostname,
        sourceUrl: location.href
      });
      lastComparables = { scan, analyzed };
      renderPanel();
    }));
    card.appendChild(actions);

    if (!lastComparables) {
      card.appendChild(h('p', 'ml-note', 'Nothing scanned yet in this tab.'));
    } else {
      const { scan, analyzed } = lastComparables;
      card.appendChild(kv('Listings found', money.formatInt(analyzed.stats.sampleSize)));
      if (analyzed.stats.sampleSize === 0) {
        card.appendChild(h('p', 'ml-alert ml-alert-warn', 'This adapter found no comparable listings on this page. Open a search or category page for the product you are researching and scan again.'));
      }
      const s = analyzed.stats;
      if (s.price.count) {
        card.appendChild(kv('Price — median', moneyText(s.price.medianPaise)));
        card.appendChild(kv('Price — range', moneyText(s.price.minPaise) + ' – ' + moneyText(s.price.maxPaise) + ' (' + s.price.count + ' readable)'));
      }
      if (s.reviews.count) {
        card.appendChild(kv('Reviews — median', money.formatInt(s.reviews.median)));
        card.appendChild(kv('Share with 1,000+ reviews', money.formatPct(s.reviews.shareOver1000 * 100, { decimals: 0 })));
      }
      if (analyzed.score) {
        card.appendChild(kv('Competition score', String(analyzed.score.value) + ' / 100 (' + analyzed.score.band + ')'));
        for (const f of analyzed.score.factors) {
          card.appendChild(h('p', 'ml-factor', f.key + ' (weight ' + f.weight + '): ' + f.explanation));
        }
        card.appendChild(h('p', 'ml-note', analyzed.score.formula));
      } else {
        card.appendChild(h('p', 'ml-alert ml-alert-warn', 'Score withheld: ' + analyzed.withheld.join(' ')));
      }
      card.appendChild(h('p', 'ml-note', analyzed.confidenceExplanation));
      card.appendChild(warnList(analyzed.limitations, 'muted'));

      // Save with a keyword label
      const labelInput = textInput('', null, 'keyword label, e.g. “cotton kurta”');
      card.appendChild(field('Save this sample under a keyword', labelInput));
      card.appendChild(button('Save sample', '', async () => {
        const label = (labelInput.value || '').trim().toLowerCase();
        if (!label) { window.alert('Enter a keyword label first.'); return; }
        const store = Object.assign({}, state.comparables);
        store[label] = {
          observedAt: Date.now(),
          sourceUrl: location.href,
          adapter: scan.adapter,
          sampleSize: analyzed.stats.sampleSize,
          priceMedianPaise: analyzed.stats.price.medianPaise,
          priceMinPaise: analyzed.stats.price.minPaise,
          priceMaxPaise: analyzed.stats.price.maxPaise,
          score: analyzed.score ? analyzed.score.value : null,
          withheld: analyzed.withheld.slice()
        };
        await send({ type: 'ml:patch', partial: { comparables: store } });
        const res = await send({ type: 'ml:getState' });
        if (res.ok) state = res.state;
        renderPanel();
      }));
    }
    return card;
  }

  // -------------------------------------------------- price & sales trend
  function priceHistoryCard() {
    const key = unitKey();
    const series = key && state.observations[key] ? state.observations[key] : [];
    const s = charts.buildSeries(series.map(o => ({ ts: o.ts, value: o.pricePaise })), { width: 520, height: 190 });
    const card = section('Price History');
    card.setAttribute('title', 'Plotted from pages you actually opened — nothing interpolated.');
    const svg = svgChart(s, { formatTick: v => moneyText(v) });
    if (svg) card.appendChild(svg);
    else card.appendChild(h('p', 'ml-note', 'No repeat price observations yet. Visit this listing again to build a genuine history.'));
    return card;
  }

  function renderTrend() {
    const wrap = ui.panel;
    wrap.appendChild(priceHistoryCard());
  }

  // ------------------------------------------------- traffic & keywords tab
  function topKeywordsCard() {
    const card = section('Title keyword candidates',
      'Mechanical phrases from this listing title only; no search volume or performance is available here.');
    const title = product.title;
    const words = title ? keywordCandidates(tokenize(title)) : [];
    const table = h('div', 'ml-table');
    const head = h('div', 'ml-keyword-row ml-table-head');
    head.appendChild(h('span', 'ml-table-label', 'Candidate phrase'));
    table.appendChild(head);
    const rows = words.slice(0, 10);
    if (!rows.length) {
      card.appendChild(h('p', 'ml-note', 'No title phrases could be generated from this page.'));
      return card;
    }
    for (let i = 0; i < rows.length; i++) {
      const k = rows[i];
      const row = h('div', 'ml-keyword-row');
      row.appendChild(h('span', 'ml-table-value', k));
      table.appendChild(row);
    }
    card.appendChild(table);
    return card;
  }

  function renderTraffic() {
    const wrap = ui.panel;
    wrap.appendChild(topKeywordsCard());
    wrap.appendChild(observedSearchPositionCard());
    wrap.appendChild(comparablesScanCard());
    wrap.appendChild(savedSamplesCard());
  }

  function savedSamplesCard() {
    const card = section('Saved comparable samples (one page each)', null);
    const keys = Object.keys(state.comparables || {}).filter(k => state.comparables[k] && state.comparables[k].kind !== 'search_capture');
    if (!keys.length) {
      card.appendChild(h('p', 'ml-note', 'None saved yet. Use “Scan this page” below on a search page and save the sample under a keyword.'));
      return card;
    }
    for (const label of keys) {
      const c = state.comparables[label];
      const row = h('div', 'ml-rule-row');
      const left = h('div', 'ml-rule-main');
      left.appendChild(h('span', 'ml-rule-name', label));
      left.appendChild(h('span', 'ml-rule-desc', money.formatInt(c.sampleSize) + ' listing(s) · median ' + moneyText(c.priceMedianPaise) +
        ' · observed ' + tsText(c.observedAt)));
      row.appendChild(left);
      row.appendChild(button('Delete', 'ml-btn-small', async () => {
        const store = Object.assign({}, state.comparables);
        delete store[label];
        await send({ type: 'ml:patch', partial: { comparables: store } });
        const res = await send({ type: 'ml:getState' });
        if (res.ok) state = res.state;
        renderPanel();
      }));
      card.appendChild(row);
    }
    return card;
  }

  function tokenize(title) {
    return String(title).toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map(w => w.replace(/^-+|-+$/g, ''))
      .filter(w => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  }
  function keywordCandidates(words) {
    const out = [];
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        const phrase = words.slice(i, i + n).join(' ');
        if (phrase.length >= 4 && out.indexOf(phrase) === -1) out.push(phrase);
      }
    }
    return out.slice(0, 18);
  }

  // --------------------------------------------------------------- watchlist
  function renderWatchlist() {
    const wrap = ui.panel;
    const card = section('Watchlist & price alerts',
      'Alerts fire only on a genuine observation (a page that was actually opened and read). The auto re-check opens the product page in a background tab.');
    if (!state.watchlist.length) {
      card.appendChild(h('p', 'ml-note', 'The watchlist is empty. Open a product page and press “Save to watchlist”.'));
    }
    for (const item of state.watchlist) {
      const row = h('div', 'ml-watch-row');
      const title = h('div', 'ml-watch-title', item.title || item.key);
      row.appendChild(title);
      const meta = h('div', 'ml-watch-meta', rules.marketplace(item.marketplace).label +
        ' · last observed ' + moneyText(item.lastPricePaise) + ' on ' + tsText(item.lastObservedAt));
      row.appendChild(meta);

      const alert = state.alerts[item.key] || {};
      const target = rupeesInput(alert.targetPricePaise === undefined ? null : alert.targetPricePaise,
        v => { writeAlert(item.key, v, alert.enabled !== false); });
      const enabled = h('input');
      enabled.type = 'checkbox';
      enabled.checked = alert.enabled !== false;
      enabled.addEventListener('change', () => writeAlert(item.key, alert.targetPricePaise === undefined ? null : alert.targetPricePaise, enabled.checked));
      const line = h('div', 'ml-watch-alert');
      line.appendChild(h('span', 'ml-field-label', 'Alert at ₹ or below'));
      line.appendChild(target);
      const lab = h('label', 'ml-check');
      lab.appendChild(enabled);
      lab.appendChild(h('span', null, 'enabled'));
      line.appendChild(lab);
      if (alert.lastNotifiedAt) line.appendChild(h('span', 'ml-note', 'Last alerted ' + tsText(alert.lastNotifiedAt)));
      row.appendChild(line);

      const actions = h('div', 'ml-actions');
      if (item.url) {
        const link = h('a', 'ml-btn ml-btn-small', 'Open');
        link.href = /^https?:\/\//i.test(item.url) ? item.url : '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        actions.appendChild(link);
      }
      actions.appendChild(button('Remove', 'ml-btn-small ml-btn-danger', async () => {
        const next = state.watchlist.filter(w => w.key !== item.key);
        const alerts = Object.assign({}, state.alerts);
        delete alerts[item.key];
        await send({ type: 'ml:patch', partial: { watchlist: next, alerts } });
        const res = await send({ type: 'ml:getState' });
        if (res.ok) state = res.state;
        renderPanel();
      }));
      row.appendChild(actions);
      card.appendChild(row);
    }
    const actions = h('div', 'ml-actions');
    actions.appendChild(button('Check watchlist now', '', async () => {
      const res = await send({ type: 'ml:recheckNow' });
      if (!res || !res.ok) window.alert('Could not start the check: ' + ((res && res.error) || 'unknown error'));
    }));
    card.appendChild(actions);
    card.appendChild(h('p', 'ml-note', 'Auto re-check interval: ' + money.formatInt(state.settings.pollIntervalMinutes) + ' minutes (Settings in the popup). Up to 2 pages per run; pages that cannot be read store nothing.'));
    wrap.appendChild(card);
  }
  async function writeAlert(key, targetPricePaise, enabled) {
    const alerts = Object.assign({}, state.alerts);
    const prev = alerts[key] || {};
    alerts[key] = {
      targetPricePaise: targetPricePaise === undefined ? null : targetPricePaise,
      enabled: enabled !== false,
      lastNotifiedAt: prev.lastNotifiedAt || null,
      lastNotifiedPricePaise: prev.lastNotifiedPricePaise === undefined ? null : prev.lastNotifiedPricePaise,
      lastObservedPricePaise: prev.lastObservedPricePaise === undefined ? null : prev.lastObservedPricePaise
    };
    await send({ type: 'ml:patch', partial: { alerts } });
    const res = await send({ type: 'ml:getState' });
    if (res.ok) state = res.state;
  }

  // --------------------------------------------------------------- go
  init();
})();
