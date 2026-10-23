// MarketLens core module: charts.js
// Pure chart geometry for the sidebar's SVG charts. No DOM here: the content
// script turns these numbers into SVG nodes. Everything is deterministic and
// unit-tested — a chart that cannot be drawn honestly reports { ok: false,
// reason } instead of drawing a misleading shape.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.charts = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function monthDay(ts) {
    const d = new Date(ts);
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  /**
   * Scale a time-series into SVG coordinates.
   * points: [{ ts, value }] — values must be finite numbers.
   * Returns { ok, reason?, svgPoints, yTicks, xTicks, bounds } — never throws.
   */
  function buildSeries(points, opts) {
    const o = opts || {};
    const width = o.width || 520, height = o.height || 190;
    const padL = o.padL === undefined ? 56 : o.padL, padR = o.padR === undefined ? 14 : o.padR;
    const padT = o.padT === undefined ? 12 : o.padT, padB = o.padB === undefined ? 26 : o.padB;
    const innerW = width - padL - padR, innerH = height - padT - padB;

    const pts = (points || []).filter(p => p && Number.isFinite(p.ts) && Number.isFinite(p.value));
    if (pts.length < 2) {
      return { ok: false, reason: pts.length === 0 ? 'no observations to chart' : 'a single point would be misleading — chart starts at two observations' };
    }
    const sorted = pts.slice().sort((a, b) => a.ts - b.ts);
    const tsMin = sorted[0].ts, tsMax = sorted[sorted.length - 1].ts;
    let vMin = Math.min.apply(null, sorted.map(p => p.value));
    let vMax = Math.max.apply(null, sorted.map(p => p.value));
    if (vMax === vMin) { vMin -= Math.abs(vMin) * 0.05 || 1; vMax += Math.abs(vMax) * 0.05 || 1; }

    const x = ts => tsMax === tsMin ? padL + innerW / 2 : padL + ((ts - tsMin) / (tsMax - tsMin)) * innerW;
    const y = v => padT + (1 - (v - vMin) / (vMax - vMin)) * innerH;

    const svgPoints = sorted.map(p => round1(x(p.ts)) + ',' + round1(y(p.value))).join(' ');

    // Y ticks: actual first / middle / last values (labels show real numbers).
    const midValue = sorted[Math.floor((sorted.length - 1) / 2)].value;
    const yTicks = [
      { y: round1(padT), value: sorted.reduce((a, p) => Math.max(a, p.value), -Infinity) },
      { y: round1(padT + innerH / 2), value: midValue },
      { y: round1(padT + innerH), value: sorted.reduce((a, p) => Math.min(a, p.value), Infinity) }
    ];

    // X ticks: up to 5 evenly spaced observations, labelled with real dates.
    const idx = [0, Math.round((sorted.length - 1) / 4), Math.round((sorted.length - 1) / 2),
      Math.round(3 * (sorted.length - 1) / 4), sorted.length - 1];
    const seen = new Set();
    const xTicks = [];
    for (const i of idx) {
      if (seen.has(i)) continue;
      seen.add(i);
      xTicks.push({ x: round1(x(sorted[i].ts)), label: monthDay(sorted[i].ts), ts: sorted[i].ts });
    }

    return { ok: true, svgPoints, yTicks, xTicks, bounds: { tsMin, tsMax, vMin, vMax, width, height, padL, padR, padT, padB } };
  }

  /**
   * Same scaling, but the path is a step (hold-then-jump) line — for counters
   * like an observed rating count.
   */
  function buildStep(points, opts) {
    const base = buildSeries(points, opts);
    if (!base.ok) return base;
    const pts = (points || []).filter(p => p && Number.isFinite(p.ts) && Number.isFinite(p.value))
      .slice().sort((a, b) => a.ts - b.ts);
    const padL = opts && opts.padL !== undefined ? opts.padL : 56;
    const padR = opts && opts.padR !== undefined ? opts.padR : 14;
    const padT = opts && opts.padT !== undefined ? opts.padT : 12;
    const padB = opts && opts.padB !== undefined ? opts.padB : 26;
    const width = (opts && opts.width) || 520, height = (opts && opts.height) || 190;
    const innerW = width - padL - padR, innerH = height - padT - padB;
    const b = base.bounds;
    const x = ts => b.tsMax === b.tsMin ? padL + innerW / 2 : padL + ((ts - b.tsMin) / (b.tsMax - b.tsMin)) * innerW;
    const y = v => padT + (1 - (v - b.vMin) / (b.vMax - b.vMin)) * innerH;

    const segments = [];
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) { segments.push({ x: x(pts[i].ts), y: y(pts[i].value) }); continue; }
      segments.push({ x: x(pts[i].ts), y: y(pts[i - 1].value) });
      segments.push({ x: x(pts[i].ts), y: y(pts[i].value) });
    }
    return Object.assign({}, base, {
      svgPoints: segments.map(p => round1(p.x) + ',' + round1(p.y)).join(' ')
    });
  }

  return { monthDay, buildSeries, buildStep };
});
