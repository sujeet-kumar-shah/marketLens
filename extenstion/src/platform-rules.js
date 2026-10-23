// MarketLens core module: platform-rules.js
// Marketplace metadata, the fee *structure* (which charges exist and how they are
// computed), and rule helpers. Rate values are NOT invented here.
//
// Verification policy
// -------------------
//  * `structure` rules describe how a charge is computed (e.g. volumetric weight
//    divisor 5000, GST on marketplace services). They still carry a verification
//    status so the UI never presents them as confirmed for the seller's account.
//  * `seller` rules are entered/confirmed by the seller (pasted from their rate
//    card, seller panel, or settlement statement) and always win over structural
//    defaults. No rate numbers ship with MarketLens.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.rules = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const money = require_ ? require_('./money.js') : globalThis.MarketLens.money;

  const RULE_VERSION = '2.0.0';

  // ---------------------------------------------------------------- fee types
  const FEE_TYPES = {
    commission:        { label: 'Commission', basis: 'price',          kind: 'percent', sign: 'charge' },
    fixed_fee:         { label: 'Fixed / closing fee', basis: 'fixed',  kind: 'fixed',   sign: 'charge' },
    collection_fee:    { label: 'Collection / payment fee', basis: 'price', kind: 'percent', sign: 'charge' },
    logistics_forward: { label: 'Forward logistics', basis: 'weight',   kind: 'slab_weight', sign: 'charge' },
    logistics_reverse: { label: 'Reverse logistics', basis: 'weight',   kind: 'slab_weight', sign: 'charge' },
    weight_handling:   { label: 'Weight handling / fulfilment', basis: 'weight', kind: 'slab_weight', sign: 'charge' },
    storage_fee:       { label: 'Storage fee', basis: 'fixed', kind: 'fixed', sign: 'charge' },
    return_adjustment: { label: 'Return / RTO adjustment', basis: 'price', kind: 'percent', sign: 'charge' },
    shipping_credit:   { label: 'Shipping credit', basis: 'fixed', kind: 'fixed', sign: 'credit' },
    reimbursement:     { label: 'Reimbursement', basis: 'fixed', kind: 'fixed', sign: 'credit' },
    gst_on_services:   { label: 'GST on marketplace services', basis: 'fees_subtotal', kind: 'percent', sign: 'charge' },
    other:             { label: 'Other marketplace charge', basis: 'fixed', kind: 'fixed', sign: 'charge' }
  };

  const WITHHOLDING_TYPES = ['tcs', 'tds']; // handled by the tax engine, not the fee engine

  // Physics/rule constants that are structural, not rate cards.
  const DEFAULTS = {
    volumetricDivisor: 5000,          // (L x W x H cm) / 5000 = kg   [cm-based divisor]
    gstOnMarketplaceServicesPct: 18   // standard Indian GST rate on services — seller must confirm applicability
  };

  // ------------------------------------------------------------ marketplaces
  const SUPPORT_LEVELS = {
    extraction_untested: 'Extraction implemented — not verified against live pages in this build',
    fee_not_implemented: 'Fee model not implemented — no rate rules for this marketplace',
    extraction_best_effort: 'Best-effort generic extraction only'
  };

  const MARKETPLACES = {
    flipkart: {
      id: 'flipkart', label: 'Flipkart India', country: 'IN', currency: 'INR', domains: ['flipkart.com'],
      capabilities: {
        extraction: 'implemented', extractionTested: true,
        priceHistory: true, comparables: 'implemented',
        feeModel: 'structure_only', profitModel: true,
        notes: [
          'Product and search pages verified live on 20 Oct 2026; class names change between builds, so JSON-LD is preferred and failures report missing fields.',
          'Commission %, fixed/closing fee and logistics slabs must come from your Flipkart rate card.',
          'Volumetric weight uses (L x W x H cm) / 5000 where the logistics rule is weight-based.',
          'Fulfilment arrangement (Flipkart-fulfilled vs self-ship) changes the logistics rules.'
        ]
      },
      fulfilments: [
        { id: 'fbf', label: 'Fulfilled by Flipkart' },
        { id: 'self', label: 'Self-ship' }
      ],
      applicableFees: {
        fbf: ['commission', 'fixed_fee', 'collection_fee', 'logistics_forward', 'logistics_reverse', 'gst_on_services'],
        self: ['commission', 'fixed_fee', 'collection_fee', 'logistics_forward', 'logistics_reverse', 'gst_on_services']
      }
    },

    amazon_in: {
      id: 'amazon_in', label: 'Amazon India', country: 'IN', currency: 'INR', domains: ['amazon.in'],
      capabilities: {
        extraction: 'implemented', extractionTested: false,
        priceHistory: true, comparables: 'implemented',
        feeModel: 'structure_only', profitModel: true,
        notes: [
          'Referral fee and closing fee depend on category and price band — enter your category rate card.',
          'Fulfilment method (FBA / seller-fulfilled) selects different weight-handling rules; rates differ.',
          'Amazon India rates are separate from Amazon US. US fees are NOT implemented in this build.'
        ]
      },
      fulfilments: [
        { id: 'fba', label: 'Fulfilled by Amazon (FBA)' },
        { id: 'self', label: 'Seller-fulfilled (Easy Ship / self-ship)' }
      ],
      applicableFees: {
        fba: ['commission', 'fixed_fee', 'weight_handling', 'storage_fee', 'return_adjustment', 'gst_on_services'],
        self: ['commission', 'fixed_fee', 'logistics_forward', 'return_adjustment', 'gst_on_services']
      }
    },

    amazon_us: {
      id: 'amazon_us', label: 'Amazon US', country: 'US', currency: 'USD', domains: ['amazon.com'],
      capabilities: {
        extraction: 'implemented', extractionTested: false,
        priceHistory: true, comparables: 'implemented',
        feeModel: 'not_implemented', profitModel: false,
        notes: [
          'US referral fees / FBA fees are NOT modelled in this build.',
          'Do not reuse Amazon India rates for the US marketplace.'
        ]
      },
      fulfilments: [],
      applicableFees: { '': ['commission', 'fixed_fee'] }
    },

    meesho: {
      id: 'meesho', label: 'Meesho', country: 'IN', currency: 'INR', domains: ['meesho.com'],
      capabilities: {
        extraction: 'implemented', extractionTested: false,
        priceHistory: true, comparables: 'none',
        feeModel: 'structure_only', profitModel: true,
        notes: [
          'Meesho has advertised 0% commission on most categories historically — confirm your current policy.',
          'Zero commission does not mean zero cost: shipping, returns and packaging are real expenses.',
          'Shipping depends on weight and destination zone; enter your slab rates.'
        ]
      },
      fulfilments: [
        { id: 'meesho_fulfilled', label: 'Meesho-fulfilled' },
        { id: 'self', label: 'Self-ship' }
      ],
      applicableFees: {
        meesho_fulfilled: ['commission', 'logistics_forward', 'logistics_reverse', 'return_adjustment', 'gst_on_services'],
        self: ['commission', 'logistics_forward', 'logistics_reverse', 'return_adjustment', 'gst_on_services']
      }
    },

    myntra: {
      id: 'myntra', label: 'Myntra', country: 'IN', currency: 'INR', domains: ['myntra.com'],
      capabilities: {
        extraction: 'implemented', extractionTested: false, priceHistory: true, comparables: 'none',
        feeModel: 'not_implemented', profitModel: false,
        notes: ['Myntra is largely a brand/partner marketplace — commission structure is contract-specific.']
      },
      fulfilments: [], applicableFees: { '': ['commission', 'gst_on_services'] }
    },

    snapdeal: {
      id: 'snapdeal', label: 'Snapdeal', country: 'IN', currency: 'INR', domains: ['snapdeal.com'],
      capabilities: {
        extraction: 'implemented', extractionTested: false, priceHistory: true, comparables: 'none',
        feeModel: 'not_implemented', profitModel: false,
        notes: ['Fee model not implemented in this build — extraction and price history only.']
      },
      fulfilments: [], applicableFees: { '': ['commission', 'fixed_fee'] }
    },

    nykaa: {
      id: 'nykaa', label: 'Nykaa', country: 'IN', currency: 'INR', domains: ['nykaa.com'],
      capabilities: {
        extraction: 'implemented', extractionTested: false, priceHistory: true, comparables: 'none',
        feeModel: 'not_implemented', profitModel: false,
        notes: ['Fee model not implemented in this build.']
      },
      fulfilments: [], applicableFees: { '': ['commission'] }
    },

    generic: {
      id: 'generic', label: 'Other store (generic)', country: 'IN', currency: 'INR', domains: [],
      capabilities: {
        extraction: 'best_effort', extractionTested: false, priceHistory: true, comparables: 'none',
        feeModel: 'seller_defined', profitModel: true,
        notes: ['No marketplace adapter: title/price read from structured data when present. Enter all fees yourself.']
      },
      fulfilments: [{ id: '', label: 'Not specified' }],
      applicableFees: { '': ['commission', 'fixed_fee', 'logistics_forward', 'return_adjustment', 'gst_on_services', 'other'] }
    }
  };

  function marketplace(id) { return MARKETPLACES[id] || MARKETPLACES.generic; }

  function applicableFeeTypes(marketplaceId, fulfilment) {
    const mp = marketplace(marketplaceId);
    const f = fulfilment || '';
    const list = mp.applicableFees[f] || mp.applicableFees[''] || mp.applicableFees[Object.keys(mp.applicableFees)[0]] || [];
    return list.slice();
  }

  // ------------------------------------------------------- rule construction
  /**
   * Canonical rule object.
   * `ratePct === null && fixedPaise === null` means "rate not entered yet" — the
   * fee engine reports it as missing. It NEVER becomes zero.
   */
  function makeRule(input) {
    const i = input || {};
    return {
      id: i.id || ('rule_' + Math.random().toString(36).slice(2, 10)),
      marketplace: i.marketplace || 'generic',
      country: i.country || 'IN',
      currency: i.currency || 'INR',
      feeType: i.feeType || 'other',
      label: i.label || (FEE_TYPES[i.feeType] ? FEE_TYPES[i.feeType].label : 'Charge'),
      category: i.category ? String(i.category).toLowerCase() : null,   // null = any category
      subcategory: i.subcategory ? String(i.subcategory).toLowerCase() : null,
      basis: i.basis || (FEE_TYPES[i.feeType] ? FEE_TYPES[i.feeType].basis : 'fixed'),
      ratePct: numOrNull(i.ratePct),
      fixedPaise: i.fixedPaise === undefined ? null : numOrNull(i.fixedPaise),
      priceBand: i.priceBand || null,          // { minPaise, maxPaise } (max exclusive)
      weightBandG: i.weightBandG || null,      // { minG, maxG } (max exclusive)
      perKgBeyondPaise: numOrNull(i.perKgBeyondPaise),
      divisor: numOrNull(i.divisor),           // volumetric divisor for weight rules
      chargeableWeight: i.chargeableWeight || (i.divisor ? 'max_actual_volumetric' : 'actual'),
      zone: i.zone || null,                    // 'local' | 'zonal' | 'national' | null (any)
      fulfilment: i.fulfilment === undefined ? null : (i.fulfilment || null),
      paymentMethod: i.paymentMethod || null,
      minFeePaise: numOrNull(i.minFeePaise),
      maxFeePaise: numOrNull(i.maxFeePaise),
      gstPct: numOrNull(i.gstPct),
      effectiveFrom: i.effectiveFrom || null,  // 'YYYY-MM-DD'
      effectiveTo: i.effectiveTo || null,
      provenance: i.provenance || 'seller',    // 'structure' | 'seller'
      verification: i.verification || 'seller_confirmed',
      sourceUrl: i.sourceUrl || null,
      lastVerifiedAt: i.lastVerifiedAt || (i.provenance === 'seller' ? Date.now() : null),
      note: i.note || null,
      sellerOverride: !!i.sellerOverride,
      version: i.version || RULE_VERSION
    };
  }

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.\-]/g, '')) : v;
    return Number.isFinite(n) ? n : null;
  }

  /** Structural rules: how charges are computed. Amounts may be null. */
  function structuralRules() {
    const gst = DEFAULTS.gstOnMarketplaceServicesPct;
    const out = [];
    for (const mpId of Object.keys(MARKETPLACES)) {
      const mp = MARKETPLACES[mpId];
      out.push(makeRule({
        id: mpId + '_gst_services_structure',
        marketplace: mpId, country: mp.country, currency: mp.currency,
        feeType: 'gst_on_services', basis: 'fees_subtotal', ratePct: gst,
        label: 'GST on marketplace services',
        provenance: 'structure', verification: 'unverified',
        note: 'Standard Indian GST rate on services is 18%. Confirm the rate and the fee base that applies to you.',
        sourceUrl: null
      }));
    }
    return out;
  }

  // ------------------------------------------------------------- precedence
  /**
   * Specificity score. Deterministic: more specific wins; explicit seller
   * overrides always outrank everything else.
   *   seller override / seller-confirmed .... 100
   *   category match ........................ 30
   *   subcategory match ..................... 10
   *   price band that is bounded ............ 12
   *   weight band ........................... 12
   *   fulfilment-specific ................... 8
   *   zone-specific ......................... 6
   *   payment-method specific ............... 4
   */
  function specificity(rule) {
    let s = 0;
    if (rule.sellerOverride) s += 100;
    // Provenance outranks structure: a rate the seller entered must never be
    // overridden by a generic structural rule.
    if (rule.provenance === 'seller') s += 50;
    else if (rule.provenance === 'structure') s += 10;
    if (rule.category) s += 30;
    if (rule.subcategory) s += 10;
    if (rule.priceBand && (rule.priceBand.minPaise !== null && rule.priceBand.minPaise !== undefined)) s += 12;
    if (rule.priceBand && rule.priceBand.maxPaise !== null && rule.priceBand.maxPaise !== undefined) s += 6;
    if (rule.weightBandG) s += 12;
    if (rule.fulfilment) s += 8;
    if (rule.zone) s += 6;
    if (rule.paymentMethod) s += 4;
    return s;
  }

  function isEffective(rule, asOfDate) {
    const d = asOfDate || new Date();
    const t = (typeof d === 'string' ? new Date(d) : d).getTime();
    if (rule.effectiveFrom && new Date(rule.effectiveFrom + 'T00:00:00').getTime() > t) return false;
    if (rule.effectiveTo && new Date(rule.effectiveTo + 'T23:59:59').getTime() < t) return false;
    return true;
  }

  function ruleHasRate(rule) {
    if (rule.kind === 'percent' || FEE_TYPES[rule.feeType] && FEE_TYPES[rule.feeType].kind === 'percent') {
      return numOrNull(rule.ratePct) !== null;
    }
    if (rule.fixedPaise !== null && rule.fixedPaise !== undefined) return true;
    return false;
  }

  function describe(rule) {
    if (!rule) return 'no rule';
    const parts = [];
    if (rule.ratePct !== null && rule.ratePct !== undefined) parts.push(rule.ratePct + '%');
    if (rule.fixedPaise !== null && rule.fixedPaise !== undefined) parts.push(money.format(rule.fixedPaise));
    return parts.join(' + ') || 'rate not entered';
  }

  return {
    RULE_VERSION, FEE_TYPES, WITHHOLDING_TYPES, DEFAULTS, MARKETPLACES, SUPPORT_LEVELS,
    marketplace, applicableFeeTypes, makeRule, structuralRules,
    specificity, isEffective, ruleHasRate, describe, numOrNull
  };
});
