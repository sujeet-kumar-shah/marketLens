// MarketLens core module: money.js
// Integer-paise arithmetic, permissive parsing and INR formatting.
// Rule: a missing value is `null` — never 0. Use nulls to signal "unknown".

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const api = factory();
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.money = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

  /** Round half away from zero (banker-free, deterministic). */
  function roundHalfAwayFromZero(x) {
    if (!Number.isFinite(x)) return null;
    return x >= 0 ? Math.round(x) : -Math.round(-x);
  }

  function isBlank(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }

  /**
   * Parse a currency-ish value into integer paise.
   * Accepts: 1299, "1,299.50", "₹1,29,999", "MRP ₹ 799", "$19.99", "Price: 1,234"
   * Returns: integer paise, or null when the value cannot be read.
   * NOTE: an explicit "0" parses to 0 (a real zero). Garbage parses to null.
   */
  function toPaise(value) {
    if (isBlank(value)) return null;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) return null;
      return roundHalfAwayFromZero(value * 100);
    }
    if (typeof value !== 'string') return null;

    // Keep digits, separators and a single decimal point.
    let s = value.replace(/[\u00a0\u202f\s]/g, '');
    s = s.replace(/[^0-9.,\-]/g, '');
    if (s === '' || s === '-' || s === '.' || s === ',') return null;
    // Comma as decimal separator (some locales) — only when a single comma, no dot.
    if (s.indexOf(',') > -1 && s.indexOf('.') === -1 && (s.match(/,/g) || []).length === 1 &&
        (s.split(',')[1] || '').length <= 2) {
      s = s.replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return roundHalfAwayFromZero(n * 100);
  }

  /** Integer paise -> number of currency units (may be fractional, e.g. 1299.5). */
  function fromPaise(paise) {
    if (!Number.isFinite(paise)) return null;
    return paise / 100;
  }

  /** round(paise * pct / 100) in integer paise. Returns null for bad input. */
  function pctOf(paise, pct) {
    if (paise === null || paise === undefined || !Number.isFinite(paise)) return null;
    if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
    return roundHalfAwayFromZero((paise * pct) / 100);
  }

  function safeDiv(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
  }

  /** Sum ignoring nulls; returns null only when every entry is null/undefined. */
  function sum(list) {
    let seen = false;
    let total = 0;
    for (const v of list || []) {
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      seen = true;
      total += v;
    }
    return seen ? total : null;
  }

  function sumOrZero(list) {
    const s = sum(list);
    return s === null ? 0 : s;
  }

  function clamp(v, min, max) {
    if (!Number.isFinite(v)) return null;
    return Math.min(max, Math.max(min, v));
  }

  function groupIndian(intStr) {
    // 1234567 -> 12,34,567
    if (intStr.length <= 3) return intStr;
    const last3 = intStr.slice(-3);
    const rest = intStr.slice(0, -3);
    return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }

  /**
   * Format integer paise for display.
   * options: { currency='INR', decimals=0|2, compact=false, signed=false, placeholder='—' }
   */
  function format(paise, options) {
    const o = Object.assign({ currency: 'INR', decimals: 0, compact: false, signed: false, placeholder: '—' }, options || {});
    if (paise === null || paise === undefined || !Number.isFinite(paise)) return o.placeholder;
    const symbol = DEFAULT_SYMBOLS[o.currency] || '';
    const negative = paise < 0;
    const abs = Math.abs(paise);

    if (o.compact && abs >= 10000000) return (negative ? '-' : '') + symbol + (abs / 10000000).toFixed(1) + 'Cr';
    if (o.compact && abs >= 100000) return (negative ? '-' : '') + symbol + (abs / 100000).toFixed(1) + 'L';
    if (o.compact && abs >= 1000) return (negative ? '-' : '') + symbol + (abs / 1000).toFixed(1) + 'K';

    const units = abs / 100;
    const fixed = o.decimals === 2 ? units.toFixed(2) : String(Math.round(units));
    const parts = fixed.split('.');
    const body = groupIndian(parts[0]) + (parts[1] ? '.' + parts[1] : '');
    const sign = negative ? '-' : (o.signed ? '+' : '');
    return sign + symbol + body;
  }

  /** Format a percentage value (already in percent units) e.g. 12.34 -> "12.3%". */
  function formatPct(pct, options) {
    const o = Object.assign({ decimals: 1, signed: false, placeholder: '—' }, options || {});
    if (pct === null || pct === undefined || !Number.isFinite(pct)) return o.placeholder;
    const sign = pct > 0 && o.signed ? '+' : '';
    return sign + pct.toFixed(o.decimals) + '%';
  }

  function formatInt(n, placeholder) {
    if (n === null || n === undefined || !Number.isFinite(n)) return placeholder || '—';
    return (n < 0 ? '-' : '') + groupIndian(String(Math.round(Math.abs(n))));
  }

  /** Round a paise value to whole rupees (used only for display, never for math). */
  function toWholeRupees(paise) {
    if (!Number.isFinite(paise)) return null;
    return roundHalfAwayFromZero(paise / 100) * 100;
  }

  return {
    roundHalfAwayFromZero, toPaise, fromPaise, pctOf, safeDiv, sum, sumOrZero,
    clamp, format, formatPct, formatInt, toWholeRupees, groupIndian, isBlank
  };
});
