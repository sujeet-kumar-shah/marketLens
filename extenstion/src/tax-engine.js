// MarketLens core module: tax-engine.js
// Separates GST / TDS / TCS handling from marketplace fee calculation.
//
// Principles
// ----------
//  * Output GST is money collected for the government — it is not revenue.
//  * GST charged on marketplace services is a cash cost when paid, and an input
//    tax credit (ITC) only if the seller is registered and can actually claim it.
//    The engine never assumes that.
//  * TCS/TDS are withheld in cash but are creditable later. They are shown as
//    "withheld", not as a permanent expense.
//  * Anything the seller has not configured is listed as EXCLUDED with a reason —
//    never silently treated as zero.
//  * No definitive tax advice: when treatment depends on the seller's
//    registration or documentation the result is flagged for professional review.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.tax = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const money = require_ ? require_('./money.js') : globalThis.MarketLens.money;

  const DEFAULT_CONFIG = {
    configured: false,
    gstRegistered: null,               // true | false | null (not set)
    gstRatePct: null,                  // rate on the product being sold
    priceIncludesGst: null,            // is the listed selling price GST-inclusive?
    claimItcOnMarketplaceFees: null,   // ITC on commission/shipping fees
    claimItcOnProductCost: null,       // ITC on purchase/manufacturing inputs
    tcsPct: null,                      // GST TCS withheld by the marketplace
    tdsPct: null,                      // income-tax TDS withheld by the marketplace
    incomeTaxPct: null,                // applied to operating profit only
    notes: []
  };

  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  function normalizeConfig(input) {
    const c = Object.assign({}, DEFAULT_CONFIG, input || {});
    c.notes = Array.isArray(input && input.notes) ? input.notes.slice() : [];
    return c;
  }

  /**
   * Classify the tax lines for one unit of sale.
   *
   * input = {
   *   pricePaise, sellerFundedDiscountPaise,
   *   gstOnMarketplaceFeesPaise,   // from the fee engine's gst_on_services component
   *   marketplaceServiceFeesPaise, // taxable service fees excluding GST
   *   productCostPaise,
   *   config
   * }
   */
  function computeTaxLines(input) {
    const i = input || {};
    const cfg = normalizeConfig(i.config);
    const grossRevenuePaise = sub(i.pricePaise, i.sellerFundedDiscountPaise || 0);

    const out = {
      config: cfg,
      grossRevenuePaise,
      outputGstPaise: null,
      netSalesRevenuePaise: grossRevenuePaise,
      gstOnMarketplaceFeesPaise: i.gstOnMarketplaceFeesPaise === undefined ? null : i.gstOnMarketplaceFeesPaise,
      itcOnMarketplaceFeesPaise: null,
      gstOnProductCostPaise: null,
      itcOnProductCostPaise: null,
      tcsPaise: null,
      tdsPaise: null,
      withheldPaise: 0,
      nonRecoverableTaxPaise: null,
      caveats: [],
      excluded: [],
      professionalReviewRequired: false,
      assumedGstInclusive: false
    };

    // ---- Output GST on the sale -------------------------------------------
    if (cfg.gstRegistered === true && isNum(cfg.gstRatePct)) {
      const r = cfg.gstRatePct;
      if (cfg.priceIncludesGst === false) {
        out.outputGstPaise = money.pctOf(grossRevenuePaise, r);
        out.netSalesRevenuePaise = grossRevenuePaise;
        out.caveats.push('Price is treated as GST-exclusive: ' + money.format(out.outputGstPaise) +
          ' GST is charged on top of the listed price.');
      } else {
        if (cfg.priceIncludesGst === null) {
          out.assumedGstInclusive = true;
          out.caveats.push('GST treatment of the price is not configured — assumed the listed price includes GST. Confirm this.');
        }
        const gst = Math.round((grossRevenuePaise * r) / (100 + r));
        out.outputGstPaise = gst;
        out.netSalesRevenuePaise = grossRevenuePaise - gst;
      }
    } else if (cfg.gstRegistered === false) {
      out.netSalesRevenuePaise = grossRevenuePaise;
      out.caveats.push('Marked as not GST-registered: product prices are treated as your revenue; no output GST or input credit modelled.');
    } else {
      out.caveats.push('GST registration not configured — output GST is not modelled. Configure it in Profit & Settlement → Tax.');
      out.excluded.push({ key: 'output_gst', label: 'Output GST on sales', reason: 'GST registration / rate not configured' });
    }

    // ---- GST paid on marketplace service fees -----------------------------
    if (out.gstOnMarketplaceFeesPaise !== null) {
      if (cfg.gstRegistered === true && cfg.claimItcOnMarketplaceFees === true) {
        out.itcOnMarketplaceFeesPaise = out.gstOnMarketplaceFeesPaise;
        out.caveats.push('GST on marketplace fees is treated as input tax credit (ITC). This requires a valid tax invoice from the marketplace and eligibility on your side.');
      } else if (cfg.gstRegistered === true && cfg.claimItcOnMarketplaceFees === false) {
        out.itcOnMarketplaceFeesPaise = 0;
        out.caveats.push('GST on marketplace fees is treated as not claimable — counted as a cost.');
      } else {
        out.excluded.push({ key: 'itc_fees', label: 'ITC on marketplace fees', reason: 'ITC treatment not configured' });
        out.professionalReviewRequired = true;
      }
    }

    // ---- GST on product cost (inputs) -------------------------------------
    if (isNum(i.productCostPaise) && i.productCostPaise > 0) {
      if (cfg.gstRegistered === true && cfg.claimItcOnProductCost === true) {
        out.itcOnProductCostPaise = null; // the cost the seller enters must be the GST-exclusive cost in that case
        out.caveats.push('ITC on product cost is claimed: enter your purchase cost EXCLUDING GST for margin accuracy.');
      } else if (cfg.gstRegistered === true && cfg.claimItcOnProductCost === false) {
        out.itcOnProductCostPaise = 0;
      } else {
        out.excluded.push({ key: 'itc_cost', label: 'ITC on product cost', reason: 'ITC treatment not configured' });
      }
    }

    // ---- Withholding: TCS (GST) and TDS (income tax) ----------------------
    if (isNum(cfg.tcsPct)) {
      out.tcsPaise = money.pctOf(grossRevenuePaise, cfg.tcsPct);
      out.withheldPaise += out.tcsPaise || 0;
    } else {
      out.excluded.push({ key: 'tcs', label: 'TCS withheld by marketplace', reason: 'TCS rate not configured' });
    }
    if (isNum(cfg.tdsPct)) {
      out.tdsPaise = money.pctOf(grossRevenuePaise, cfg.tdsPct);
      out.withheldPaise += out.tdsPaise || 0;
    } else {
      out.excluded.push({ key: 'tds', label: 'TDS withheld by marketplace', reason: 'TDS rate not configured' });
    }
    if (out.tcsPaise || out.tdsPaise) {
      out.caveats.push('TCS/TDS are withheld in cash but are creditable against your GST / income-tax liability — they are shown as withheld, not as a permanent cost.');
    }

    // ---- Non-recoverable tax in the business view -------------------------
    const nonRec = [];
    if (out.gstOnMarketplaceFeesPaise !== null) {
      const itc = out.itcOnMarketplaceFeesPaise || 0;
      nonRec.push(out.gstOnMarketplaceFeesPaise - itc);
    }
    out.nonRecoverableTaxPaise = nonRec.length ? money.sumOrZero(nonRec) : null;

    return out;
  }

  function sub(a, b) {
    if (a === null || a === undefined || !Number.isFinite(a)) return null;
    return a - (b || 0);
  }
  /** Plain-language summary for the UI badge. */
  function describeConfig(cfg) {
    const c = normalizeConfig(cfg);
    if (c.gstRegistered === null) return { text: 'Tax treatment not configured', tone: 'warn' };
    if (c.gstRegistered === false) return { text: 'Not GST-registered', tone: 'info' };
    if (!isNum(c.gstRatePct)) return { text: 'GST-registered — product GST rate not set', tone: 'warn' };
    const bits = ['GST ' + c.gstRatePct + '%'];
    bits.push(c.claimItcOnMarketplaceFees === true ? 'ITC on fees claimed' : c.claimItcOnMarketplaceFees === false ? 'no ITC on fees' : 'ITC on fees not set');
    if (isNum(c.tcsPct)) bits.push('TCS ' + c.tcsPct + '%');
    if (isNum(c.tdsPct)) bits.push('TDS ' + c.tdsPct + '%');
    return { text: bits.join(' • '), tone: 'ok' };
  }

  return { DEFAULT_CONFIG, normalizeConfig, computeTaxLines, describeConfig };
});
