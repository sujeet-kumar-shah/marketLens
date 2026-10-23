// MarketLens core module: price-history.js
// Genuine, timestamped observations only. There is no synthetic price series in
// MarketLens: an empty chart stays empty and says why.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.history = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const money = require_ ? require_('./money.js') : globalThis.MarketLens.money;

  const SOURCE = {
    LISTING_VISIT: 'listing_visit',     // the seller opened the product page
    TAB_REFRESH: 'tab_refresh',         // background asked an open tab to re-read the price
    MANUAL_ENTRY: 'manual_entry',       // seller typed an observed price
    SELLER_STATEMENT: 'seller_statement'
  };

  const SOURCE_LABELS = {
    listing_visit: 'You opened this page',
    tab_refresh: 'Automatic re-check in an open tab',
    manual_entry: 'You entered it manually',
    seller_statement: 'From your seller statement'
  };

  const MAX_POINTS_PER_PRODUCT = 400;
  const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; // don't store the same price within 6 hours

  function normalizeObservation(obs) {
    if (!obs || typeof obs.pricePaise !== 'number' || !Number.isFinite(obs.pricePaise) || obs.pricePaise <= 0) return null;
    return {
      ts: typeof obs.ts === 'number' ? obs.ts : Date.now(),
      pricePaise: Math.round(obs.pricePaise),
      source: obs.source || SOURCE.LISTING_VISIT,
      sellerName: obs.sellerName || null,
      variantKey: obs.variantKey || null,
      reviewCount: typeof obs.reviewCount === 'number' && Number.isFinite(obs.reviewCount) && obs.reviewCount >= 0 ? Math.round(obs.reviewCount) : null,
      title: obs.title || null
    };
  }

  /**
   * Append an observation. Returns { series, added, reason }.
   * Dedupe rules: identical timestamp, or the same price inside the dedupe window.
   */
  function addObservation(series, obs, options) {
    const o = Object.assign({ dedupeWindowMs: DEDUPE_WINDOW_MS, maxPoints: MAX_POINTS_PER_PRODUCT }, options || {});
    const clean = normalizeObservation(obs);
    const list = Array.isArray(series) ? series.slice() : [];
    if (!clean) return { series: list, added: false, reason: 'invalid_observation' };

    const last = list[list.length - 1];
    if (last) {
      if (last.ts === clean.ts) return { series: list, added: false, reason: 'duplicate_timestamp' };
      // Same price inside the window is only a duplicate when nothing else we
      // track (review count) has moved — a review change is a new observation.
      if (last.pricePaise === clean.pricePaise && Math.abs(clean.ts - last.ts) < o.dedupeWindowMs &&
          (clean.reviewCount === null || last.reviewCount === null || clean.reviewCount === last.reviewCount)) {
        return { series: list, added: false, reason: 'same_price_within_window' };
      }
      if (clean.ts < last.ts) {
        // keep the series ordered without dropping the data
        list.push(clean);
        list.sort((a, b) => a.ts - b.ts);
        return { series: trim(list, o.maxPoints), added: true, reason: 'out_of_order' };
      }
    }
    list.push(clean);
    return { series: trim(list, o.maxPoints), added: true, reason: 'ok' };
  }

  function trim(list, maxPoints) {
    return list.length > maxPoints ? list.slice(list.length - maxPoints) : list;
  }

  /** Observed statistics for a window. No interpolation, no synthetic points. */
  function windowStats(series, options) {
    const o = Object.assign({ days: 90, now: Date.now() }, options || {});
    const list = (Array.isArray(series) ? series : []).filter(p => p && Number.isFinite(p.pricePaise));
    const cutoff = o.now - o.days * 86400000;
    const inWindow = list.filter(p => p.ts >= cutoff);
    const prices = inWindow.map(p => p.pricePaise);
    const sorted = prices.slice().sort((a, b) => a - b);
    const avg = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
    const first = inWindow.length ? inWindow[0] : null;
    const last = inWindow.length ? inWindow[inWindow.length - 1] : null;
    const spanDays = inWindow.length > 1 ? (inWindow[inWindow.length - 1].ts - inWindow[0].ts) / 86400000 : 0;

    return {
      days: o.days,
      count: inWindow.length,
      totalCount: list.length,
      highPaise: sorted.length ? sorted[sorted.length - 1] : null,
      lowPaise: sorted.length ? sorted[0] : null,
      medianPaise: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      avgPaise: avg,
      currentPaise: last ? last.pricePaise : null,
      firstPaise: first ? first.pricePaise : null,
      changePaise: (first && last) ? last.pricePaise - first.pricePaise : null,
      changePct: (first && last && first.pricePaise) ? ((last.pricePaise - first.pricePaise) / first.pricePaise) * 100 : null,
      lastObservedAt: last ? last.ts : null,
      firstObservedAt: first ? first.ts : null,
      spanDays,
      sufficient: inWindow.length >= 3 && spanDays >= 3,
      observations: inWindow
    };
  }

  /** Human-readable honesty about the amount of history available. */
  function historyStatus(stats) {
    if (!stats || stats.count === 0) {
      return {
        level: 'none',
        message: 'No price observations stored yet. MarketLens records a price only when you open the product page (or when a watchlist tab re-checks it). It never invents history.'
      };
    }
    if (stats.count === 1) {
      return {
        level: 'insufficient',
        message: 'Only one observation (' + money.format(stats.currentPaise) + '). A trend needs at least 2 observations on different days — a chart of one point would be misleading, so none is drawn.'
      };
    }
    if (!stats.sufficient) {
      return {
        level: 'limited',
        message: 'Limited history: ' + stats.count + ' observations spanning ' + Math.round(stats.spanDays) + ' day(s). Treat any trend as indicative only.'
      };
    }
    return { level: 'ok', message: stats.count + ' observations spanning ' + Math.round(stats.spanDays) + ' days.' };
  }

  /** Log of genuine price changes (distinct consecutive prices). */
  function changeLog(series, limit) {
    const list = (Array.isArray(series) ? series : []).slice().sort((a, b) => a.ts - b.ts);
    const changes = [];
    let prev = null;
    for (const p of list) {
      if (!prev) { prev = p; continue; }
      if (p.pricePaise !== prev.pricePaise) {
        changes.push({
          ts: p.ts,
          fromPaise: prev.pricePaise,
          toPaise: p.pricePaise,
          deltaPaise: p.pricePaise - prev.pricePaise,
          pct: prev.pricePaise ? ((p.pricePaise - prev.pricePaise) / prev.pricePaise) * 100 : null,
          source: p.source,
          sellerChanged: !!(prev.sellerName && p.sellerName && prev.sellerName !== p.sellerName),
          fromSeller: prev.sellerName || null,
          toSeller: p.sellerName || null
        });
        prev = p;
      }
    }
    const out = changes.reverse();
    return typeof limit === 'number' ? out.slice(0, limit) : out;
  }

  /** Sparkline coordinates for a real series; caller decides whether to draw. */
  function sparkline(observations, width, height) {
    const list = (observations || []).filter(o => Number.isFinite(o.pricePaise));
    if (list.length < 2) return { points: '', drawable: false, reason: 'need at least 2 observations' };
    const prices = list.map(o => o.pricePaise);
    const min = Math.min(...prices), max = Math.max(...prices);
    const range = (max - min) || 1;
    const t0 = list[0].ts, t1 = list[list.length - 1].ts;
    const timeRange = (t1 - t0) || 1;
    const points = list.map(o => {
      const x = ((o.ts - t0) / timeRange) * width;
      const y = height - ((o.pricePaise - min) / range) * height;
      return Math.round(x) + ',' + Math.round(y);
    }).join(' ');
    return { points, drawable: true, minPaise: min, maxPaise: max };
  }

  return { SOURCE, SOURCE_LABELS, MAX_POINTS_PER_PRODUCT, DEDUPE_WINDOW_MS, normalizeObservation, addObservation, windowStats, historyStatus, changeLog, sparkline };
});
