// MarketLens core module: data-quality.js
// Provenance records. Every number the UI shows should be traceable to one of
// these statuses. There is deliberately NO single opaque "confidence score".

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const api = factory();
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.dq = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATUS = {
    VERIFIED_STATEMENT: 'verified_statement',      // seller-provided order/settlement statement
    OBSERVED: 'observed',                          // read off a live listing
    CALCULATED_VERIFIED: 'calculated_verified',    // derived only from verified inputs
    CALCULATED_ASSUMPTION: 'calculated_assumption',// derived with at least one assumption
    SELLER_INPUT: 'seller_input',                  // typed in by the seller (unconfirmed)
    SELLER_CONFIRMED: 'seller_confirmed',          // seller confirmed a rule/rate for their account
    ESTIMATED: 'estimated',                        // indirect signal, explicitly modelled
    UNVERIFIED: 'unverified',                      // present but not checked against a source
    STALE: 'stale',                                // was verified, now past freshness window
    INSUFFICIENT: 'insufficient',                  // not enough evidence to compute
    MISSING: 'missing',                            // required value absent
    NOT_APPLICABLE: 'not_applicable',              // platform/order type does not use it
    EXCLUDED: 'excluded'                           // real component intentionally left out
  };

  const LABELS = {
    verified_statement: 'From your statement',
    observed: 'Observed on listing',
    calculated_verified: 'Calculated (verified inputs)',
    calculated_assumption: 'Calculated (includes assumptions)',
    seller_input: 'Your input',
    seller_confirmed: 'You confirmed this rate',
    estimated: 'Modelled estimate',
    unverified: 'Unverified — needs checking',
    stale: 'Out of date — re-check',
    insufficient: 'Insufficient data',
    missing: 'Missing input',
    not_applicable: 'Not applicable',
    excluded: 'Excluded from total'
  };

  // css class suffixes reused by content.css
  const TONE = {
    verified_statement: 'ok',
    observed: 'ok',
    calculated_verified: 'ok',
    seller_confirmed: 'ok',
    calculated_assumption: 'warn',
    seller_input: 'info',
    estimated: 'warn',
    unverified: 'warn',
    stale: 'warn',
    insufficient: 'bad',
    missing: 'bad',
    not_applicable: 'muted',
    excluded: 'muted'
  };

  const TRUSTED = [STATUS.VERIFIED_STATEMENT, STATUS.OBSERVED, STATUS.CALCULATED_VERIFIED, STATUS.SELLER_CONFIRMED];

  /** Build a provenance record. `value` may be null. */
  function q(value, meta) {
    const m = meta || {};
    let status = m.status || (value === null || value === undefined ? STATUS.MISSING : STATUS.UNVERIFIED);
    let note = m.note || null;

    if (status === STATUS.OBSERVED && m.maxAgeMs && m.observedAt) {
      const age = Date.now() - m.observedAt;
      if (age > m.maxAgeMs) {
        status = STATUS.STALE;
        note = note || 'Observation is older than the freshness window';
      }
    }
    return {
      value: value === undefined ? null : value,
      status,
      source: m.source || null,
      sourceUrl: m.sourceUrl || null,
      observedAt: m.observedAt || null,
      ruleId: m.ruleId || null,
      note
    };
  }

  function label(status) { return LABELS[status] || 'Unclassified'; }
  function tone(status) { return TONE[status] || 'muted'; }
  function isKnown(prov) { return !!prov && prov.value !== null && prov.value !== undefined && prov.status !== STATUS.MISSING; }
  function isTrusted(prov) { return !!prov && TRUSTED.indexOf(prov.status) > -1; }
  function isAssumption(prov) {
    return !!prov && [STATUS.ESTIMATED, STATUS.UNVERIFIED, STATUS.CALCULATED_ASSUMPTION, STATUS.SELLER_INPUT].indexOf(prov.status) > -1;
  }

  /** Worst status wins when aggregating a set of provenances. */
  function aggregate(provenances) {
    const list = (provenances || []).filter(Boolean);
    if (!list.length) return STATUS.MISSING;
    const order = [
      STATUS.MISSING, STATUS.INSUFFICIENT, STATUS.STALE, STATUS.UNVERIFIED,
      STATUS.ESTIMATED, STATUS.SELLER_INPUT, STATUS.CALCULATED_ASSUMPTION,
      STATUS.CALCULATED_VERIFIED, STATUS.OBSERVED, STATUS.SELLER_CONFIRMED, STATUS.VERIFIED_STATEMENT
    ];
    let worstIdx = order.length - 1;
    for (const p of list) {
      const idx = order.indexOf(p.status);
      if (idx > -1 && idx < worstIdx) worstIdx = idx;
    }
    return order[worstIdx];
  }

  /** Human-readable list of caveats for the UI. */
  function warnings(provenances, limit) {
    const out = [];
    for (const p of (provenances || [])) {
      if (!p) continue;
      if ([STATUS.MISSING, STATUS.INSUFFICIENT, STATUS.STALE, STATUS.UNVERIFIED, STATUS.ESTIMATED].indexOf(p.status) === -1) continue;
      const text = (p.note || label(p.status)) + (p.source ? ' (' + p.source + ')' : '');
      if (out.indexOf(text) === -1) out.push(text);
    }
    return typeof limit === 'number' ? out.slice(0, limit) : out;
  }

  function ageInDays(ts, now) {
    if (!ts) return null;
    const ref = now || Date.now();
    return Math.floor((ref - ts) / 86400000);
  }

  function freshness(verifiedAt, opts) {
    const o = Object.assign({ warnDays: 90, staleDays: 180 }, opts || {});
    const days = ageInDays(verifiedAt);
    if (days === null) return { days: null, status: STATUS.UNVERIFIED, note: 'Never verified' };
    if (days >= o.staleDays) return { days, status: STATUS.STALE, note: 'Last checked ' + days + ' days ago' };
    if (days >= o.warnDays) return { days, status: STATUS.UNVERIFIED, note: 'Last checked ' + days + ' days ago — re-verify' };
    return { days, status: STATUS.SELLER_CONFIRMED, note: 'Checked ' + days + ' days ago' };
  }

  return { STATUS, LABELS, TONE, q, label, tone, isKnown, isTrusted, isAssumption, aggregate, warnings, ageInDays, freshness };
});
