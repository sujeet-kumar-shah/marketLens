// MarketLens 2.3 — Background Service Worker (MV3, classic worker)
// Responsibilities:
//   * Single writer for chrome.storage.local. Every read/write goes through
//     MarketLens.storage so stored data is validated and repaired on the way in
//     and on the way out. UI contexts (content script, popup) never write
//     directly — they send 'ml:patch' / 'ml:observe' messages.
//   * Watchlist re-check alarm: opens the watched product page in an inactive tab.
//     The page's own content script reports what it ACTUALLY reads. If nothing
//     can be read, no observation is stored and no alert is raised.
//   * Price alerts are evaluated only against a genuine observation just stored,
//     and only fire once per downward crossing of the target.

importScripts(
  'src/money.js',
  'src/data-quality.js',
  'src/product-model.js',
  'src/platform-rules.js',
  'src/price-history.js',
  'src/storage.js'
);

const ML = globalThis.MarketLens;
const storage = ML.storage;
const history = ML.history;
const money = ML.money;

const ALARM_WATCHLIST = 'ml:watchlist';
const ALARM_CLEANUP = 'ml:cleanup';
const AUTO_TAB_CAP = 2;              // never open more than this many tabs per run
const AUTO_TAB_MAX_AGE_MS = 120000;  // tabs that never reported are closed after 2 minutes

/** tabId -> { key, openedAt } for tabs this worker opened for a re-check. */
const autoOpened = new Map();

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); });

async function ensureAlarm() {
  try {
    const { state } = await storage.load();
    const minutes = Math.max(60, Number(state.settings.pollIntervalMinutes) || 360);
    const existing = await chrome.alarms.get(ALARM_WATCHLIST);
    if (!existing || existing.periodInMinutes !== minutes) {
      await chrome.alarms.create(ALARM_WATCHLIST, { periodInMinutes: minutes, delayInMinutes: 10 });
    }
  } catch (e) {
    // Alarms are best-effort; the extension remains fully usable without them.
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_WATCHLIST) await recheckWatchlist();
  if (alarm.name === ALARM_CLEANUP) await closeStaleAutoTabs();
});

/**
 * Open watched product pages in inactive tabs. Only products with an ENABLED
 * alert and a URL are touched. Nothing is read here — the content script of the
 * opened page reports the observation, or reports nothing at all.
 */
async function recheckWatchlist() {
  const { state } = await storage.load();
  if (!state.settings.notifications) return;
  const targets = state.watchlist.filter(w => w && w.url && state.alerts[w.key] && state.alerts[w.key].enabled);
  let openedAny = false;
  for (const w of targets.slice(0, AUTO_TAB_CAP)) {
    try {
      const tab = await chrome.tabs.create({ url: w.url, active: false });
      if (tab && tab.id !== undefined) {
        autoOpened.set(tab.id, { key: w.key, openedAt: Date.now() });
        openedAny = true;
      }
    } catch (e) {
      // Bad URL or tab quota: skip. Nothing is fabricated to compensate.
    }
  }
  if (openedAny) {
    try { await chrome.alarms.create(ALARM_CLEANUP, { when: Date.now() + AUTO_TAB_MAX_AGE_MS + 5000 }); } catch (e) {}
  }
}

async function closeStaleAutoTabs() {
  for (const [tabId, info] of autoOpened) {
    if (Date.now() - info.openedAt >= AUTO_TAB_MAX_AGE_MS) {
      autoOpened.delete(tabId);
      try { await chrome.tabs.remove(tabId); } catch (e) { /* tab already gone */ }
    }
  }
}

// ------------------------------------------------------------------ messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('ml:') !== 0) return;
  handleMessage(msg, sender)
    .then(result => sendResponse(result))
    .catch(err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'ml:getState': {
      const { state, issues } = await storage.load();
      return { ok: true, state, issues };
    }
    case 'ml:patch': {
      const { state } = await storage.load();
      const merged = storage.mergeInto(state, msg.partial || {});
      storage.evict(merged);
      const clean = await storage.save(merged);
      return { ok: true, state: clean };
    }
    case 'ml:observe': {
      return recordObservation(msg.observation, sender);
    }
    case 'ml:recheckNow': {
      await recheckWatchlist();
      return { ok: true };
    }
    case 'ml:clearAll': {
      await storage.clearAll();
      return { ok: true };
    }
    default:
      return { ok: false, error: 'Unknown message type: ' + msg.type };
  }
}

/**
 * Store a price/review observation that a content script ACTUALLY read from a
 * live page. Rejects anything that is not a genuine positive price.
 */
async function recordObservation(obs, sender) {
  if (!obs || typeof obs.key !== 'string' || typeof obs.pricePaise !== 'number' ||
      !Number.isFinite(obs.pricePaise) || obs.pricePaise <= 0) {
    return { ok: false, error: 'Observation rejected: a genuine, positive observed price is required.' };
  }

  const fromAutoTab = !!(sender && sender.tab && autoOpened.has(sender.tab.id));
  const clean = {
    ts: typeof obs.ts === 'number' ? obs.ts : Date.now(),
    pricePaise: Math.round(obs.pricePaise),
    source: fromAutoTab ? 'tab_refresh' : (obs.source || 'listing_visit'),
    sellerName: obs.sellerName || null,
    reviewCount: typeof obs.reviewCount === 'number' ? obs.reviewCount : null,
    title: obs.title || null
  };

  const { state } = await storage.load();
  const series = Array.isArray(state.observations[obs.key]) ? state.observations[obs.key] : [];
  const result = history.addObservation(series, clean);
  const partial = { observations: {} };
  partial.observations[obs.key] = result.series;
  const next = storage.mergeInto(state, partial);
  storage.evict(next);

  // Watchlist snapshot (only from the observation we just stored).
  const item = next.watchlist.find(w => w.key === obs.key);
  if (item && result.added) {
    item.lastObservedAt = clean.ts;
    item.lastPricePaise = clean.pricePaise;
    if (clean.sellerName) item.lastSellerName = clean.sellerName;
  }

  // Alert: only on a stored observation, only downward crossings.
  let notified = false;
  const alert = next.alerts[obs.key];
  if (alert) alert.lastObservedPricePaise = clean.pricePaise;
  if (item && result.added && alert && alert.enabled && alert.targetPricePaise !== null &&
      clean.pricePaise <= alert.targetPricePaise) {
    const previousNotified = alert.lastNotifiedPricePaise;
    if (previousNotified === null || clean.pricePaise < previousNotified) {
      try {
        await chrome.notifications.create('ml:' + obs.key + ':' + clean.ts, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'MarketLens price alert',
          message: (item.title || 'Watched product') + ' was observed at ' + money.format(clean.pricePaise) +
            ' — at or below your target of ' + money.format(alert.targetPricePaise) + '.'
        });
        notified = true;
        alert.lastNotifiedAt = Date.now();
        alert.lastNotifiedPricePaise = clean.pricePaise;
      } catch (e) {
        // Notification permission/quota: the observation is still stored.
      }
    }
  }

  const saved = await storage.save(next);

  // Close the tab this worker opened, once it has reported.
  if (fromAutoTab && sender.tab) {
    autoOpened.delete(sender.tab.id);
    try { await chrome.tabs.remove(sender.tab.id); } catch (e) {}
  }

  const savedItem = saved.watchlist.find(w => w.key === obs.key);
  return {
    ok: true,
    stored: result.added,
    reason: result.reason,
    notified,
    lastPricePaise: savedItem ? savedItem.lastPricePaise : clean.pricePaise
  };
}
