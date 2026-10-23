// MarketLens core module: product-model.js
// The single internal representation of an observed product.
// Missing information is ALWAYS null — never 0, never "N/A" leaking into math.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.model = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const money = require_ ? require_('./money.js') : globalThis.MarketLens.money;
  const dq = require_ ? require_('./data-quality.js') : globalThis.MarketLens.dq;

  // Fields we model. `required` fields block settlement/profit math when absent.
  const FIELDS = [
    { key: 'marketplace', label: 'Marketplace', required: false },
    { key: 'country', label: 'Country', required: false },
    { key: 'currency', label: 'Currency', required: false },
    { key: 'url', label: 'Product URL', required: false },
    { key: 'productId', label: 'Product ID', required: false },
    { key: 'variantKey', label: 'Variant', required: false },
    { key: 'title', label: 'Title', required: true },
    { key: 'brand', label: 'Brand', required: false },
    { key: 'category', label: 'Category', required: false },
    { key: 'subcategory', label: 'Subcategory', required: false },
    { key: 'pricePaise', label: 'Selling price', required: true },
    { key: 'mrpPaise', label: 'MRP', required: false },
    { key: 'discountPct', label: 'Discount %', required: false },
    { key: 'rating', label: 'Rating', required: false },
    { key: 'reviewCount', label: 'Review count', required: false },
    { key: 'sellerName', label: 'Seller', required: false },
    { key: 'sellerId', label: 'Seller ID', required: false },
    { key: 'fulfilment', label: 'Fulfilment', required: false },
    { key: 'actualWeightG', label: 'Actual weight (g)', required: false },
    { key: 'packedWeightG', label: 'Packed weight (g)', required: false },
    { key: 'packedDimsCm', label: 'Packed dimensions (cm)', required: false },
    { key: 'stockStatus', label: 'Stock status', required: false },
    { key: 'attributes', label: 'Attributes', required: false },
    { key: 'observationTs', label: 'Observed at', required: false }
  ];

  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  }

  /**
   * Normalise raw extractor output into the standard model.
   * `fieldProvenance` maps field key -> provenance record produced by the adapter.
   */
  function createProduct(raw, fieldProvenance) {
    const r = raw || {};
    const prov = Object.assign({}, fieldProvenance || {});

    const product = {
      marketplace: r.marketplace || null,
      country: r.country || 'IN',
      currency: r.currency || 'INR',
      url: r.url || null,
      productId: r.productId || null,
      variantKey: r.variantKey || null,
      title: isEmpty(r.title) ? null : String(r.title).trim(),
      brand: isEmpty(r.brand) ? null : String(r.brand).trim(),
      category: r.category || null,
      subcategory: r.subcategory || null,
      pricePaise: numOrNull(r.pricePaise),
      mrpPaise: numOrNull(r.mrpPaise),
      discountPct: numOrNull(r.discountPct),
      rating: numOrNull(r.rating),
      reviewCount: numOrNull(r.reviewCount),
      sellerName: r.sellerName || null,
      sellerId: r.sellerId || null,
      fulfilment: r.fulfilment || null,
      actualWeightG: numOrNull(r.actualWeightG),
      packedWeightG: numOrNull(r.packedWeightG),
      packedDimsCm: r.packedDimsCm && r.packedDimsCm.l && r.packedDimsCm.w && r.packedDimsCm.h ? r.packedDimsCm : null,
      stockStatus: r.stockStatus || null,           // 'in_stock' | 'out_of_stock' | null (unknown)
      attributes: r.attributes || null,
      observationTs: r.observationTs || Date.now(),
      extractionStatus: r.extractionStatus || 'unknown', // 'ok' | 'partial' | 'dom_changed'
      fieldProvenance: prov
    };

    // Derived: discount only when both inputs exist and MRP > price.
    if (product.discountPct === null && product.mrpPaise !== null && product.pricePaise !== null && product.mrpPaise > product.pricePaise) {
      product.discountPct = money.roundHalfAwayFromZero(((product.mrpPaise - product.pricePaise) / product.mrpPaise) * 100);
      prov.discountPct = dq.q(product.discountPct, { status: 'calculated_verified', note: 'Derived from MRP and selling price' });
    }
    // An MRP equal to price is not a discount; an MRP below price is data noise.
    if (product.mrpPaise !== null && product.pricePaise !== null && product.mrpPaise <= product.pricePaise) {
      product.mrpPaise = product.pricePaise;
      if (product.discountPct === null) product.discountPct = 0;
    }

    return product;
  }

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.\-]/g, '')) : v;
    return Number.isFinite(n) ? n : null;
  }

  /** Stable storage key. Variants are kept apart so price history never mixes them. */
  function unitKey(product) {
    if (!product) return null;
    const mk = product.marketplace || 'unknown';
    const id = product.productId || (product.url ? hashKey(product.url) : 'unknown');
    const variant = product.variantKey || 'default';
    return mk + ':' + id + ':' + variant;
  }

  function hashKey(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(36);
  }

  const PRICE_FIELD_FALLBACK_LABELS = {
    title: 'product title',
    pricePaise: 'selling price'
  };

  /** Missing required/optional fields, with the reason a calculation is blocked. */
  function missingFields(product) {
    const out = [];
    for (const f of FIELDS) {
      if (isEmpty(product[f.key])) out.push({ key: f.key, label: f.label, required: f.required });
    }
    return out;
  }

  function blockingMissingFields(product) {
    return missingFields(product).filter(f => f.required);
  }

  /** How much of the model we actually read (0..1) + which fields are absent. */
  function completeness(product) {
    const missing = missingFields(product);
    const total = FIELDS.length;
    return {
      filled: total - missing.length,
      total,
      ratio: (total - missing.length) / total,
      missing
    };
  }

  /** Build a provenance map for a freshly extracted product (adapter-provided selectors). */
  function provenanceFromExtraction(extraction, url, observedAt) {
    const prov = {};
    const fields = (extraction && extraction.fields) || {};
    for (const key of Object.keys(fields)) {
      const f = fields[key];
      if (!f || f.value === null || f.value === undefined || f.value === '') {
        prov[key] = dq.q(null, { status: 'missing', source: 'listing extraction', sourceUrl: url, note: 'Selector not found on page' });
      } else {
        prov[key] = dq.q(f.value, {
          status: 'observed',
          source: 'listing (' + (f.selector || 'structure') + ')',
          sourceUrl: url,
          observedAt
        });
      }
    }
    return prov;
  }

  return { FIELDS, createProduct, unitKey, missingFields, blockingMissingFields, completeness, provenanceFromExtraction, hashKey };
});
