// MarketLens core module: storage.js
// Validated persistence with an explicit schema version and a migration from the
// v1 layout (watchlist / priceAlerts / priceHistory). Every read is repaired
// before use so a corrupt or partial record can never crash the UI or leak
// garbage into calculations.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.storage = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const SCHEMA_VERSION = 2;
  const MAX_OBSERVATION_KEYS = 500;
  const MAX_COMPARABLE_KEYS = 60;

  function defaults() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: {
        notifications: true,
        showBadges: true,
        autoOpenSidebar: false,
        currency: 'INR',
        reconciliationTolerancePaise: 50,
        pollIntervalMinutes: 360
      },
      taxConfig: {
        configured: false,
        gstRegistered: null,
        gstRatePct: null,
        priceIncludesGst: null,
        claimItcOnMarketplaceFees: null,
        claimItcOnProductCost: null,
        tcsPct: null,
        tdsPct: null,
        incomeTaxPct: null
      },
      products: {},        // unitKey -> seller inputs + last observed snapshot
      watchlist: [],       // [{ key, marketplace, productId, title, url, image, ... }]
      observations: {},    // unitKey -> [{ ts, pricePaise, source, reviewCount? }]
      alerts: {},          // unitKey -> { targetPricePaise, enabled, lastNotifiedAt, lastNotifiedPricePaise, lastObservedPricePaise }
      feeRules: [],        // seller rules + imported rules (only real entries ever persist)
      comparables: {},     // keyword/adapter -> { observedAt, sourceUrl, listings }
      meta: { installedAt: Date.now(), lastMigration: null, notes: [] }
    };
  }

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

  /** Coerce/repair a loaded state so downstream code can trust its shape. */
  function validate(raw) {
    const state = defaults();
    const issues = [];
    if (!isObj(raw)) {
      issues.push('Stored data was not an object — reset to defaults (your own entries could not be read).');
      return { state, issues };
    }
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      issues.push('Stored schema version ' + (raw.schemaVersion === undefined ? 'missing' : raw.schemaVersion) + ' → migrated to ' + SCHEMA_VERSION + '.');
    }

    if (isObj(raw.settings)) {
      for (const k of Object.keys(state.settings)) {
        if (raw.settings[k] !== undefined && raw.settings[k] !== null) state.settings[k] = raw.settings[k];
      }
    }

    if (isObj(raw.taxConfig)) {
      for (const k of Object.keys(state.taxConfig)) {
        if (raw.taxConfig[k] !== undefined) state.taxConfig[k] = raw.taxConfig[k];
      }
      state.taxConfig.configured = state.taxConfig.gstRegistered !== null;
    }

    if (isObj(raw.products)) {
      for (const key of Object.keys(raw.products)) {
        const p = raw.products[key];
        if (isObj(p)) state.products[key] = p;
      }
    } else if (Array.isArray(raw.products)) {
      issues.push('products was an array — ignored.');
    }

    if (Array.isArray(raw.watchlist)) {
      const seen = new Set();
      for (const item of raw.watchlist) {
        if (!isObj(item)) continue;
        const key = item.key || item.id || item.url;
        if (!key || seen.has(key)) continue;      // duplicate watchlist entries are dropped
        seen.add(key);
        state.watchlist.push({
          key,
          marketplace: item.marketplace || item.platform || 'generic',
          productId: item.productId || null,
          title: typeof item.title === 'string' ? item.title : null,
          url: item.url || null,
          image: item.image || null,
          addedAt: num(item.addedAt) || num(item.savedAt) || Date.now(),
          lastObservedAt: num(item.lastObservedAt) || null,
          lastPricePaise: num(item.lastPricePaise) || (num(item.price) !== null ? Math.round(item.price * 100) : null),
          fulfilment: item.fulfilment || null
        });
      }
    }

    if (isObj(raw.observations)) {
      for (const key of Object.keys(raw.observations)) {
        const list = raw.observations[key];
        if (!Array.isArray(list)) continue;
        state.observations[key] = list
          .filter(o => isObj(o) && num(o.pricePaise) !== null && num(o.pricePaise) > 0)
          .map(o => ({
            ts: num(o.ts) || num(o.date) || Date.now(),
            pricePaise: Math.round(o.pricePaise || o.price),
            source: o.source || 'listing_visit',
            sellerName: o.sellerName || null,
            reviewCount: num(o.reviewCount),
            title: o.title || null
          }))
          .slice(-400);
      }
    }

    if (isObj(raw.alerts)) {
      for (const key of Object.keys(raw.alerts)) {
        const a = raw.alerts[key];
        if (!isObj(a)) continue;
        state.alerts[key] = {
          targetPricePaise: num(a.targetPricePaise) || (num(a.targetPrice) !== null ? Math.round(a.targetPrice * 100) : null),
          enabled: a.enabled !== false,
          lastNotifiedAt: num(a.lastNotifiedAt),
          lastNotifiedPricePaise: num(a.lastNotifiedPricePaise),
          lastObservedPricePaise: num(a.lastObservedPricePaise)
        };
        if (state.alerts[key].targetPricePaise === null) delete state.alerts[key];
      }
    }

    if (Array.isArray(raw.feeRules)) {
      state.feeRules = raw.feeRules.filter(r => isObj(r) && r.provenance !== 'example');   // stale placeholder rules from older exports are dropped
    }
    if (isObj(raw.comparables)) state.comparables = raw.comparables;
    if (isObj(raw.meta)) state.meta = Object.assign(state.meta, raw.meta);
    return { state, issues };
  }

  /** v1 → v2 migration (v1 kept everything in flat keys). */
  function migrateV1(raw) {
    const out = defaults();
    const issues = [];
    if (!isObj(raw)) return { state: out, issues };

    if (Array.isArray(raw.watchlist)) {
      out.watchlist = raw.watchlist.map(item => {
        const id = item.id || item.url;
        if (!id) return null;
        return {
          key: id,
          marketplace: item.platform || 'generic',
          productId: item.productId || (item.id && String(item.id).split(':').pop()) || null,
          title: item.title || null,
          url: item.url || null,
          image: item.image || null,
          addedAt: num(item.savedAt) || Date.now(),
          lastPricePaise: num(item.price) !== null ? Math.round(item.price * 100) : null
        };
      }).filter(Boolean);
      issues.push('Migrated ' + out.watchlist.length + ' watchlist item(s) from the v1 layout.');
    }

    if (isObj(raw.priceHistory)) {
      for (const key of Object.keys(raw.priceHistory)) {
        const list = Array.isArray(raw.priceHistory[key]) ? raw.priceHistory[key] : [];
        out.observations[key] = list
          .filter(o => isObj(o) && (num(o.price) !== null || num(o.pricePaise) !== null))
          .map(o => ({
            ts: num(o.date) || Date.now(),
            pricePaise: num(o.pricePaise) !== null ? Math.round(o.pricePaise) : Math.round(o.price * 100),
            source: 'listing_visit'
          }));
      }
      issues.push('Migrated genuine price observations for ' + Object.keys(out.observations).length + ' product(s). v1 stored points without dedupe, so duplicates may remain — they are harmless for high/low but visible in the log.');
    }

    const legacyAlerts = Array.isArray(raw.priceAlerts) ? raw.priceAlerts : [];
    for (const a of legacyAlerts) {
      if (!isObj(a)) continue;
      const key = a.productId;
      if (!key) continue;
      const target = num(a.targetPrice) !== null ? Math.round(a.targetPrice * 100) : num(a.targetPricePaise);
      if (target === null) continue;
      out.alerts[key] = { targetPricePaise: target, enabled: true, lastNotifiedAt: null, lastNotifiedPricePaise: null, lastObservedPricePaise: null };
    }

    if (isObj(raw.settings)) out.settings = Object.assign(out.settings, {
      notifications: raw.settings.notifications !== false,
      showBadges: raw.settings.showBadges !== false,
      autoOpenSidebar: !!raw.settings.autoAnalyze,
      currency: raw.settings.currency || 'INR'
    });

    issues.push('v1 keyword/trending/price-history-fabrication data is intentionally NOT migrated: those numbers were generated randomly and are not carried forward.');
    return { state: out, issues };
  }

  // ------------------------------------------------------------ adapters
  function areaOf(area) {
    if (area) return area;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local;
    return memoryArea();
  }

  function memoryArea(seed) {
    const store = Object.assign({}, seed || {});
    return {
      __memory: store,
      async get(keys) {
        if (keys === null || keys === undefined) return Object.assign({}, store);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (store[k] !== undefined) out[k] = store[k];
        return out;
      },
      async set(obj) { Object.assign(store, obj); return true; },
      async remove(keys) {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
        return true;
      },
      async clear() { for (const k of Object.keys(store)) delete store[k]; return true; }
    };
  }

  const KEYS = ['settings', 'taxConfig', 'products', 'watchlist', 'observations', 'alerts', 'feeRules', 'comparables', 'meta', 'schemaVersion'];

  /** Load + validate. Falls back to migrating a v1 payload if present. */
  async function load(area) {
    const a = areaOf(area);
    const raw = await a.get(KEYS.concat(['priceHistory', 'priceAlerts', 'analyzedToday']));
    const hasV2 = raw.schemaVersion === SCHEMA_VERSION;
    if (hasV2) {
      const { state, issues } = validate(raw);
      return { state, issues };
    }
    const hasV1Signals = raw.priceHistory || raw.priceAlerts || (Array.isArray(raw.watchlist) && raw.watchlist.length);
    const { state, issues } = hasV1Signals ? migrateV1(raw) : validate(raw);
    return { state, issues };
  }

  async function save(state, area) {
    const a = areaOf(area);
    const { state: clean } = validate(state);
    await a.set({
      schemaVersion: SCHEMA_VERSION,
      settings: clean.settings,
      taxConfig: clean.taxConfig,
      products: clean.products,
      watchlist: clean.watchlist,
      observations: clean.observations,
      alerts: clean.alerts,
      feeRules: clean.feeRules,
      comparables: clean.comparables,
      meta: clean.meta
    });
    return clean;
  }

  async function patch(partial, area) {
    const { state } = await load(area);
    return save(Object.assign(state, partial), area);
  }

  /**
   * Section-wise merge used by the message-based single-writer (background).
   * Maps merge key-by-key; settings/taxConfig/meta merge; arrays replace.
   */
  function mergeInto(base, partial) {
    const out = isObj(base) ? base : defaults();
    const p = partial || {};
    if (isObj(p.settings)) out.settings = Object.assign({}, out.settings, p.settings);
    if (isObj(p.taxConfig)) out.taxConfig = Object.assign({}, out.taxConfig, p.taxConfig);
    for (const mapKey of ['products', 'observations', 'alerts', 'comparables', 'ruleMeta']) {
      if (isObj(p[mapKey])) out[mapKey] = Object.assign({}, out[mapKey] || {}, p[mapKey]);
    }
    if (isObj(p.meta)) out.meta = Object.assign({}, out.meta, p.meta);
    if (Array.isArray(p.watchlist)) out.watchlist = p.watchlist.slice();
    if (Array.isArray(p.feeRules)) out.feeRules = p.feeRules.slice();
    return out;
  }

  /** Drop observations for the least recently seen products to respect quota. */
  function evict(state) {
    const keys = Object.keys(state.observations);
    if (keys.length > MAX_OBSERVATION_KEYS) {
      const ranked = keys.map(k => {
        const list = state.observations[k] || [];
        const last = list.length ? list[list.length - 1].ts : 0;
        return { k, last };
      }).sort((a, b) => a.last - b.last);
      const drop = ranked.slice(0, ranked.length - MAX_OBSERVATION_KEYS).map(r => r.k);
      for (const k of drop) delete state.observations[k];
      state.meta.notes = (state.meta.notes || []).concat(['Evicted price history for ' + drop.length + ' product(s) to stay within storage limits (oldest first).']);
    }

    // Search captures are re-created automatically every time the page is
    // opened, so the oldest ones are dropped first. Hand-saved keyword samples
    // (no kind: 'search_capture') are never evicted here.
    const cmp = state.comparables || (state.comparables = {});
    const cmpKeys = Object.keys(cmp);
    if (cmpKeys.length > MAX_COMPARABLE_KEYS) {
      const ranked = cmpKeys
        .map(k => ({ k, at: (cmp[k] && cmp[k].observedAt) || 0 }))
        .sort((a, b) => a.at - b.at);
      let dropped = 0;
      for (const r of ranked) {
        if (Object.keys(cmp).length <= MAX_COMPARABLE_KEYS) break;
        if (cmp[r.k] && cmp[r.k].kind === 'search_capture') { delete cmp[r.k]; dropped++; }
      }
      if (dropped) {
        state.meta.notes = (state.meta.notes || []).concat(['Evicted ' + dropped + ' old search capture(s) to stay within storage limits (they are captured again whenever you open that search page).']);
      }
    }
    return state;
  }

  function exportJSON(state) {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      note: 'MarketLens export. Contains your seller-entered costs and genuine price observations. Nothing here has been uploaded anywhere.',
      data: state
    }, null, 2);
  }

  function importJSON(text, area) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: 'Not valid JSON.' }; }
    const payload = parsed && parsed.data ? parsed.data : parsed;
    if (!isObj(payload)) return { ok: false, error: 'JSON structure not recognised.' };
    const { state, issues } = validate(payload);
    return { ok: true, state, issues, save: () => save(state, area) };
  }

  async function clearAll(area) {
    const a = areaOf(area);
    await a.remove(KEYS.concat(['priceHistory', 'priceAlerts', 'searchHistory', 'analyzedToday', 'lastAnalyzedDate']));
    return true;
  }

  return {
    SCHEMA_VERSION, MAX_OBSERVATION_KEYS, MAX_COMPARABLE_KEYS, KEYS, defaults, validate, migrateV1, mergeInto,
    load, save, patch, evict, exportJSON, importJSON, clearAll, memoryArea
  };
});
