// MarketLens core module: competition.js
// Comparable-listing statistics and (only with enough data) a documented score.
// Every factor and weight is exposed so the seller can audit it.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.competition = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const MIN_SAMPLE = 5;
  const MIN_PRICE_COVERAGE = 0.8;

  const DEFAULT_WEIGHTS = {
    priceDispersion: 0.25,
    reviewBarrier: 0.30,
    ratingSpread: 0.15,
    brandConcentration: 0.15,
    sellerSpread: 0.15
  };

  function median(sorted) {
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  function hhi(shares) {
    return shares.reduce((acc, s) => acc + s * s, 0); // 0..1
  }

  function concentration(values) {
    const counts = new Map();
    for (const v of values) {
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (!total) return { top: null, topShare: null, hhi: null, unique: 0 };
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return {
      top: sorted[0][0],
      topShare: sorted[0][1] / total,
      hhi: hhi([...counts.values()].map(c => c / total)),
      unique: counts.size
    };
  }

  function listFrom(value, key, options) {
    const o = options || {};
    return value
      .map(v => v[key])
      .filter(v => v !== null && v !== undefined && (!o.positive || v > 0))
      .sort((a, b) => a - b);
  }

  /**
   * analyzeComparables({ listings, self, weights })
   * listings: [{ title, pricePaise, rating, reviewCount, sellerName, brand, url }]
   */
  function analyzeComparables(input) {
    const i = input || {};
    const listings = (i.listings || []).filter(l => l && (l.title || l.pricePaise));
    const n = listings.length;

    const priceSeries = listFrom(listings, 'pricePaise', { positive: true });
    const ratingSeries = listFrom(listings, 'rating', { positive: true });
    const reviewSeries = listFrom(listings, 'reviewCount', { positive: false });

    const priceCoverage = n ? priceSeries.length / n : 0;
    const meanPrice = priceSeries.length ? Math.round(priceSeries.reduce((a, b) => a + b, 0) / priceSeries.length) : null;
    const sd = priceSeries.length > 1 && meanPrice
      ? Math.sqrt(priceSeries.reduce((acc, p) => acc + Math.pow(p - meanPrice, 2), 0) / priceSeries.length)
      : null;
    const cv = meanPrice && sd !== null ? sd / meanPrice : null;

    const brand = concentration(listings.map(l => l.brand));
    const seller = concentration(listings.map(l => l.sellerName));

    const stats = {
      sampleSize: n,
      observedAt: i.observedAt || Date.now(),
      source: i.source || 'listing scan',
      sourceUrl: i.sourceUrl || null,
      price: {
        count: priceSeries.length,
        minPaise: priceSeries.length ? priceSeries[0] : null,
        maxPaise: priceSeries.length ? priceSeries[priceSeries.length - 1] : null,
        medianPaise: median(priceSeries),
        meanPaise: meanPrice,
        standardDeviationPaise: sd === null ? null : Math.round(sd),
        coefficientOfVariation: cv
      },
      rating: {
        count: ratingSeries.length,
        median: median(ratingSeries),
        min: ratingSeries.length ? ratingSeries[0] : null,
        max: ratingSeries.length ? ratingSeries[ratingSeries.length - 1] : null,
        mean: ratingSeries.length ? ratingSeries.reduce((a, b) => a + b, 0) / ratingSeries.length : null
      },
      reviews: {
        count: reviewSeries.length,
        median: median(reviewSeries),
        max: reviewSeries.length ? reviewSeries[reviewSeries.length - 1] : null,
        shareUnder100: reviewSeries.length ? reviewSeries.filter(r => r < 100).length / reviewSeries.length : null,
        shareOver1000: reviewSeries.length ? reviewSeries.filter(r => r >= 1000).length / reviewSeries.length : null
      },
      brand: brand,
      seller: seller,
      sponsored: listings.filter(l => l.sponsored).length
    };

    const weights = Object.assign({}, DEFAULT_WEIGHTS, i.weights || {});
    const withheld = [];
    if (n < MIN_SAMPLE) withheld.push('Only ' + n + ' comparable listing(s) in the sample — at least ' + MIN_SAMPLE + ' are needed before a score means anything.');
    if (priceCoverage < MIN_PRICE_COVERAGE) withheld.push('Price was readable on only ' + Math.round(priceCoverage * 100) + '% of listings.');

    let score = null;
    if (!withheld.length) {
      const factors = [];

      // 1. Price dispersion: tight clustering = price war; wide spread = room to differentiate.
      const cvNorm = cv === null ? 0.5 : Math.min(1, cv / 0.6);
      factors.push({
        key: 'priceDispersion', weight: weights.priceDispersion,
        value: cv === null ? null : Math.round(cv * 1000) / 1000,
        normalized: cvNorm,
        explanation: 'Price spread across comparables (coefficient of variation ' + (cv === null ? 'n/a' : cv.toFixed(2)) + '). Wide spreads suggest room to differentiate; tight spreads suggest price-led competition.'
      });

      // 2. Review barrier: how many rivals already have deep review counts.
      const strongShare = stats.reviews.shareOver1000 === null ? 0.5 : stats.reviews.shareOver1000;
      factors.push({
        key: 'reviewBarrier', weight: weights.reviewBarrier,
        value: strongShare, normalized: strongShare,
        explanation: Math.round(strongShare * 100) + '% of comparable listings already have 1,000+ reviews — that is the barrier a new listing faces.'
      });

      // 3. Rating spread: little spread means quality is not the differentiator.
      const ratingSpread = (stats.rating.max !== null && stats.rating.min !== null) ? stats.rating.max - stats.rating.min : null;
      const ratingNorm = ratingSpread === null ? 0.5 : Math.max(0, Math.min(1, (5 - ratingSpread) / 5));
      factors.push({
        key: 'ratingSpread', weight: weights.ratingSpread,
        value: ratingSpread, normalized: ratingNorm,
        explanation: 'Observed rating range ' + (ratingSpread === null ? 'n/a' : ratingSpread.toFixed(1)) + ' stars.'
      });

      // 4. Brand concentration (HHI).
      factors.push({
        key: 'brandConcentration', weight: weights.brandConcentration,
        value: brand.hhi === null ? null : Math.round(brand.hhi * 1000) / 1000,
        normalized: brand.hhi === null ? 0.5 : brand.hhi,
        explanation: brand.top ? 'Top brand “' + brand.top + '” holds ' + Math.round(brand.topShare * 100) + '% of the sample.' : 'Brand not readable on the sample.'
      });

      // 5. Seller spread.
      const sellerNorm = seller.hhi === null ? 0.5 : seller.hhi;
      factors.push({
        key: 'sellerSpread', weight: weights.sellerSpread,
        value: seller.unique,
        normalized: sellerNorm,
        explanation: seller.unique + ' distinct seller/brand names readable in the sample.'
      });

      const value = Math.round(factors.reduce((acc, f) => acc + f.weight * f.normalized, 0) * 100);
      score = {
        value,
        band: value >= 70 ? 'crowded' : value >= 45 ? 'mixed' : 'open',
        factors,
        formula: 'score = 100 × Σ(weightᵢ × normalised factorᵢ) with weights ' +
          Object.keys(weights).map(k => k + '=' + weights[k]).join(', ') +
          '. Higher = more competitive/crowded. Factors are documented above; this is a derived score, not marketplace data.'
      };
    }

    return {
      stats,
      score,
      withheld: withheld,
      confidence: n >= 15 ? 'medium' : n >= MIN_SAMPLE ? 'low' : 'withheld',
      confidenceExplanation: 'Based on ' + n + ' listings read from ' + (i.source || 'one page') + ' at one point in time. One page is a sample, not the whole market.',
      limitations: [
        'A single search page is not the whole market — it is what the marketplace chose to show.',
        'Review counts are cumulative and never prove sales volume.',
        'Comparable listings are not guaranteed to be the same product or variant.'
      ]
    };
  }

  const DEFAULT_OPPORTUNITY_WEIGHTS = {
    profitability: 0.35, demandEvidence: 0.25, competition: 0.20, priceStability: 0.10, dataCompleteness: 0.10
  };

  /**
   * opportunityScore — withheld unless profitability, competition and demand
   * evidence are all present. A profitable product with unknown demand is NOT an
   * opportunity, and the score refuses to imply that it is.
   */
  function opportunityScore(input) {
    const i = input || {};
    const weights = Object.assign({}, DEFAULT_OPPORTUNITY_WEIGHTS, i.weights || {});
    const withheld = [];
    const factors = [];

    if (typeof i.contributionMarginPct !== 'number') withheld.push('Profitability is not modelled yet (complete Profit & Settlement).');
    if (!i.competitionScore || typeof i.competitionScore.value !== 'number') withheld.push('Competition score is not available (scan comparable listings first).');
    if (!i.salesEstimate || i.salesEstimate.status === 'insufficient') withheld.push('Demand evidence is insufficient (see the Sales estimate section).');

    if (withheld.length) {
      return {
        value: null, withheld, weights,
        message: 'Opportunity score withheld until the underlying data exists. A profitable product with unknown demand is not an opportunity — it is an untested bet.',
        factors: []
      };
    }

    const profitNorm = Math.max(0, Math.min(1, i.contributionMarginPct / 30));
    factors.push({ key: 'profitability', weight: weights.profitability, normalized: profitNorm, explanation: 'Contribution margin ' + i.contributionMarginPct.toFixed(1) + '% (normalised at 30%).' });

    const demandNorm = i.salesEstimate.status === 'verified' ? 1 : Math.max(0, Math.min(1, i.salesEstimate.bands.base / 300));
    factors.push({ key: 'demandEvidence', weight: weights.demandEvidence, normalized: demandNorm, explanation: 'Demand evidence: ' + i.salesEstimate.status + (i.salesEstimate.bands ? ' (~' + i.salesEstimate.bands.base + ' units/month, modelled)' : '') });

    const compNorm = 1 - Math.max(0, Math.min(1, i.competitionScore.value / 100));
    factors.push({ key: 'competition', weight: weights.competition, normalized: compNorm, explanation: 'Competition score ' + i.competitionScore.value + '/100 inverted (lower competition scores better).' });

    const stabilityNorm = typeof i.priceStability === 'number' ? Math.max(0, Math.min(1, i.priceStability)) : 0.5;
    factors.push({ key: 'priceStability', weight: weights.priceStability, normalized: stabilityNorm, explanation: typeof i.priceStability === 'number' ? 'Observed price stability ' + (stabilityNorm * 100).toFixed(0) + '%.' : 'Price stability not measurable yet — neutral 50% used and labelled.' });

    const completenessNorm = typeof i.dataCompleteness === 'number' ? Math.max(0, Math.min(1, i.dataCompleteness)) : 0.5;
    factors.push({ key: 'dataCompleteness', weight: weights.dataCompleteness, normalized: completenessNorm, explanation: 'Data completeness ' + (completenessNorm * 100).toFixed(0) + '% of the product model.' });

    const value = Math.round(factors.reduce((acc, f) => acc + f.weight * f.normalized, 0) * 100);
    return {
      value,
      band: value >= 70 ? 'strong' : value >= 45 ? 'moderate' : 'weak',
      factors, weights, withheld: [],
      message: 'Derived from the factors above. It is not a prediction of sales and does not guarantee success.',
      formula: 'score = 100 × Σ(weightᵢ × normalisedᵢ); weights are configurable, defaults: ' +
        Object.keys(weights).map(k => k + '=' + weights[k]).join(', ')
    };
  }

  return { analyzeComparables, opportunityScore, MIN_SAMPLE, DEFAULT_WEIGHTS, DEFAULT_OPPORTUNITY_WEIGHTS };
});
