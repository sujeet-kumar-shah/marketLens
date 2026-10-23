// MarketLens core module: profit-engine.js
// Settlement, contribution, target pricing, discount simulation, advertising,
// return/RTO modelling and monthly forecasting. Pure functions — no DOM.
//
// Metrics are deliberately separated:
//   cash settlement  !=  net sales revenue  !=  contribution  !=  operating profit
// Nothing here is ever called "final net profit".

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.profit = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const money = require_ ? require_('./money.js') : globalThis.MarketLens.money;
  const taxEngine = require_ ? require_('./tax-engine.js') : globalThis.MarketLens.tax;

  function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

  /** base - rest... ; null when the base itself is unknown (missing costs must not vanish). */
  function sub(base) {
    if (base === null || base === undefined || !Number.isFinite(base)) return null;
    let total = base;
    for (let i = 1; i < arguments.length; i++) {
      const a = arguments[i];
      if (a === null || a === undefined || !Number.isFinite(a)) continue;
      total -= a;
    }
    return total;
  }
  function add(a, b) {
    if (a === null || a === undefined) return b === undefined ? null : b;
    if (b === null || b === undefined) return a;
    return a + b;
  }
  function ratioPct(numerator, denominator) {
    const r = money.safeDiv(numerator, denominator);
    return r === null ? null : r * 100;
  }

  /**
   * Suggested per-return loss, built from the fee engine's reverse-logistics rule
   * plus packaging. This is a SUGGESTION for the seller to confirm — it is never
   * used as a default silently.
   */
  function suggestReturnLoss(fees, packagingPaise) {
    if (!fees) return { valuePaise: null, basis: null };
    const rev = (fees.components || []).filter(c => c.feeType === 'logistics_reverse' && c.status === 'computed');
    if (!rev.length) return { valuePaise: null, basis: null };
    const amount = money.sumOrZero(rev.map(c => c.amountPaise)) + (packagingPaise || 0);
    return {
      valuePaise: amount,
      basis: 'Reverse logistics (' + rev.map(c => c.ruleId).join(', ') + ') + packaging ' + money.format(packagingPaise || 0) +
        '. Damaged or unsellable inventory is NOT included — add it if it applies to you.'
    };
  }

  /**
   * Core unit economics.
   * Returns BOTH views: `cash` (what the marketplace pays out / you pay) and
   * `business` (revenue net of GST with configured ITC treatment).
   */
  function unitEconomics(input) {
    const i = input || {};
    // Fees are either supplied directly, or recomputed at the current price via a
    // callback — the price solver needs percentage fees and price bands to change
    // with every candidate price instead of being frozen at the entered price.
    let fees = i.fees || null;
    if (!fees && typeof i.feeAtPrice === 'function') fees = i.feeAtPrice(i.pricePaise) || null;
    const gstOnMarketplaceServicesPaise = fees && fees.totals ? fees.totals.gstOnServicesPaise : null;
    const tax = i.tax || taxEngine.computeTaxLines({
      pricePaise: i.pricePaise,
      sellerFundedDiscountPaise: i.sellerFundedDiscountPaise || 0,
      gstOnMarketplaceFeesPaise: gstOnMarketplaceServicesPaise,
      config: i.taxConfig
    });

    const missing = [];
    const caveats = [];
    // The tax engine's own caveats (ITC treatment, TCS/TDS withheld, unconfigured
    // registration…) belong to the same result and must not be lost.
    if (tax && Array.isArray(tax.caveats)) for (const c of tax.caveats) caveats.push(c);

    const price = num(i.pricePaise);
    if (price === null) missing.push({ key: 'pricePaise', label: 'Selling price', why: 'Cannot compute anything without the selling price' });

    const productCost = num(i.productCostPaise);
    if (productCost === null) missing.push({ key: 'productCostPaise', label: 'Product cost (COGS)', why: 'Enter your purchase / manufacturing cost per unit' });

    const allMarketplaceCharges = fees && fees.totals ? fees.totals.chargesPaise : null;
    // Charges that only occur when an order comes back are kept OUT of the
    // delivered-order settlement: the return provision models them instead. The
    // amount is still reported so the UI can show what was excluded.
    const returnContingentCharges = (() => {
      if (!fees || !Array.isArray(fees.components)) return 0;
      const rc = fees.components.filter(c => c.status === 'computed' &&
        (c.feeType === 'logistics_reverse' || c.feeType === 'return_adjustment'));
      return rc.length ? money.sumOrZero(rc.map(c => c.amountPaise)) : 0;
    })();
    const marketplaceCharges = allMarketplaceCharges === null ? null : allMarketplaceCharges - returnContingentCharges;
    const gstOnFees = gstOnMarketplaceServicesPaise;
    if (!fees || fees.complete !== true) {
      caveats.push('Marketplace charge total is incomplete: ' + ((fees && fees.missing.length) || 0) + ' charge(s) unresolved. The settlement below excludes them.');
    }

    const sellerShipping = num(i.sellerPaidShippingPaise);
    const packaging = num(i.packagingPaise) || 0;
    const labels = num(i.labelsPaise) || 0;
    const otherPrep = num(i.otherPrepPaise) || 0;
    const prepCosts = packaging + labels + otherPrep;
    const otherVariable = num(i.otherVariablePaise) || 0;
    const adsPerOrder = num(i.adsPerOrderPaise);
    const fixedMonthly = num(i.fixedMonthlyPaise);
    const ordersPerMonth = num(i.ordersPerMonth);

    // ---- Return / RTO provision -------------------------------------------
    const returnRate = num(i.returnRatePct);
    const rtoRate = num(i.rtoRatePct);
    const lossPerReturn = num(i.lossPerReturnPaise);
    const lossPerRto = num(i.lossPerRtoPaise);
    let returnProvision = null;
    const returnParts = [];
    if (returnRate !== null) {
      if (lossPerReturn === null) {
        missing.push({ key: 'lossPerReturnPaise', label: 'Loss per returned order', why: 'Return rate is set but the cost of a return is not — enter it or leave the return rate blank' });
      } else {
        returnParts.push(money.pctOf(money.roundHalfAwayFromZero(lossPerReturn), returnRate));
      }
    } else {
      missing.push({ key: 'returnRatePct', label: 'Return rate', why: 'Enter your observed or expected return rate (or leave it blank to exclude returns entirely)' });
    }
    if (rtoRate !== null) {
      if (lossPerRto === null) {
        missing.push({ key: 'lossPerRtoPaise', label: 'Loss per RTO order', why: 'RTO rate is set but the cost of an RTO is not' });
      } else {
        returnParts.push(money.pctOf(money.roundHalfAwayFromZero(lossPerRto), rtoRate));
      }
    } else {
      missing.push({ key: 'rtoRatePct', label: 'RTO rate', why: 'Enter your observed or expected RTO rate' });
    }
    if (returnParts.length === 2) returnProvision = money.sumOrZero(returnParts);
    else if (returnParts.length === 1) {
      returnProvision = returnParts[0];
      caveats.push('Only part of the return/RTO provision could be computed — see missing inputs.');
    }
    if (returnContingentCharges > 0) {
      caveats.push(money.format(returnContingentCharges) + ' of return-contingent charges (reverse logistics / return adjustment) are excluded from the delivered-order settlement — they apply only when an order is returned.' +
        (returnProvision !== null
          ? ' Your return provision covers returns; make sure its loss per return does not count these same charges twice.'
          : ' Add a return rate and loss per return above to cost returns explicitly.'));
    }

    // ---- Business view ----------------------------------------------------
    const businessRevenue = tax.netSalesRevenuePaise;
    const itcOnFees = tax.itcOnMarketplaceFeesPaise || 0;
    const nonRecoverableGstOnFees = gstOnFees === null || gstOnFees === undefined ? null : Math.max(0, gstOnFees - itcOnFees);

    const businessMarketplaceCost =
      marketplaceCharges === null ? null :
      (gstOnFees === null || gstOnFees === undefined ? marketplaceCharges : marketplaceCharges - itcOnFees);

    // Contribution is only reported when every load-bearing input is known.
    // A missing COGS or an unresolved charge list must never inflate profit.
    const contributionInputsKnown =
      businessRevenue !== null && businessRevenue !== undefined &&
      productCost !== null &&
      businessMarketplaceCost !== null && businessMarketplaceCost !== undefined;

    const businessContributionBeforeAds = !contributionInputsKnown ? null : sub(
      businessRevenue,
      productCost,
      prepCosts,
      sellerShipping,
      businessMarketplaceCost,
      returnProvision,
      otherVariable
    );

    if (!contributionInputsKnown) {
      if (productCost === null) caveats.push('Contribution profit not shown: product cost is missing.');
      else if (businessMarketplaceCost === null) caveats.push('Contribution profit not shown: marketplace charges are not resolved.');
    }

    const businessContributionAfterAds = businessContributionBeforeAds === null ? null
      : (adsPerOrder === null ? null : businessContributionBeforeAds - adsPerOrder);

    // ---- Cash view --------------------------------------------------------
    const cashGrossIn = sub(price, num(i.sellerFundedDiscountPaise) || 0);
    const cashWithheld = tax.withheldPaise || 0;
    const cashSettlement = sub(
      cashGrossIn,
      marketplaceCharges,
      cashWithheld
    );

    // ---- Margins, ROI -----------------------------------------------------
    const grossInForMargin = tax.grossRevenuePaise;
    const contributionMarginPct = ratioPct(businessContributionBeforeAds, businessRevenue);
    const contributionMarginOnPricePct = ratioPct(businessContributionBeforeAds, grossInForMargin);
    const roiPct = productCost && productCost > 0 ? ratioPct(businessContributionBeforeAds, productCost) : null;

    // ---- Monthly ----------------------------------------------------------
    let operatingProfitMonthly = null;
    let operatingProfitPerUnit = null;
    if (businessContributionAfterAds !== null && ordersPerMonth && ordersPerMonth > 0) {
      const fixedForAll = fixedMonthly === null ? 0 : fixedMonthly;
      operatingProfitMonthly = businessContributionAfterAds * ordersPerMonth - fixedForAll;
      operatingProfitPerUnit = businessContributionAfterAds - (fixedForAll / ordersPerMonth);
      if (fixedMonthly === null) {
        caveats.push('Monthly fixed costs not entered — operating profit only covers per-unit contribution.');
      }
    } else if (businessContributionAfterAds !== null && fixedMonthly !== null) {
      caveats.push('Enter your expected monthly order volume to allocate fixed costs.');
      missing.push({ key: 'ordersPerMonth', label: 'Orders per month', why: 'Needed to allocate fixed monthly costs' });
    }

    let profitAfterIncomeTax = null;
    const incomeTaxPct = num(tax.config && tax.config.incomeTaxPct);
    if (incomeTaxPct !== null && operatingProfitMonthly !== null) {
      if (operatingProfitMonthly <= 0) {
        profitAfterIncomeTax = operatingProfitMonthly;
      } else {
        profitAfterIncomeTax = operatingProfitMonthly - money.pctOf(operatingProfitMonthly, incomeTaxPct);
      }
      caveats.push('Profit after income tax uses the flat rate you configured (' + incomeTaxPct + '%) and ignores slabs, deductions and advance-tax timing. Confirm with your accountant.');
    } else if (incomeTaxPct === null) {
      caveats.push('Income tax has NOT been calculated — configure a rate only if you want a rough post-tax view.');
    }

    const result = {
      pricePaise: price,
      grossRevenuePaise: tax.grossRevenuePaise,
      outputGstPaise: tax.outputGstPaise,
      netSalesRevenuePaise: businessRevenue,
      components: {
        productCostPaise: productCost,
        prepCostsPaise: prepCosts,
        packagingPaise: packaging,
        labelsPaise: labels,
        otherPrepPaise: otherPrep,
        sellerShippingPaise: sellerShipping,
        marketplaceChargesPaise: marketplaceCharges,
        returnContingentChargesPaise: returnContingentCharges,
        gstOnMarketplaceFeesPaise: gstOnFees,
        itcOnMarketplaceFeesPaise: tax.itcOnMarketplaceFeesPaise,
        nonRecoverableGstOnFeesPaise: nonRecoverableGstOnFees,
        returnProvisionPaise: returnProvision,
        otherVariablePaise: otherVariable,
        adsPerOrderPaise: adsPerOrder,
        fixedMonthlyPaise: fixedMonthly,
        tcsPaise: tax.tcsPaise,
        tdsPaise: tax.tdsPaise
      },
      cash: {
        grossInPaise: cashGrossIn,
        marketplaceChargesPaise: marketplaceCharges,
        withheldPaise: cashWithheld,
        settlementPaise: cashSettlement,
        note: 'Cash expected to reach your bank account for a delivered order, before COGS and other costs.'
      },
      business: {
        netSalesRevenuePaise: businessRevenue,
        marketplaceCostPaise: businessMarketplaceCost,
        contributionBeforeAdsPaise: businessContributionBeforeAds,
        contributionAfterAdsPaise: businessContributionAfterAds,
        operatingProfitPerUnitPaise: operatingProfitPerUnit,
        operatingProfitMonthlyPaise: operatingProfitMonthly,
        profitAfterIncomeTaxMonthlyPaise: profitAfterIncomeTax,
        contributionMarginPct: contributionMarginPct,
        contributionMarginOnPricePct: contributionMarginOnPricePct,
        roiOnProductCostPct: roiPct
      },
      tax,
      fees,
      missing,
      caveats,
      readiness: {
        settlementKnown: cashSettlement !== null,
        contributionKnown: businessContributionBeforeAds !== null,
        operatingKnown: operatingProfitMonthly !== null,
        postTaxKnown: profitAfterIncomeTax !== null
      }
    };
    return result;
  }

  // ------------------------------------------------------------------ solver
  /**
   * Find the lowest selling price at which `valueFn(pricePaise)` reaches `target`.
   *
   * The price -> metric relationship is NOT assumed to be linear: percentage
   * fees, price bands and clamps make it piecewise. We scan on a coarse grid,
   * bracket the first crossing, then bisect to 1 paise. Every returned price is
   * verified by re-evaluating the metric at that price.
   *
   * valueFn must return a finite number or null (null = not computable there).
   */
  function solvePrice(options) {
    const o = options || {};
    const valueFn = o.valueFn;
    const target = num(o.target);
    const minPaise = num(o.minPaise) === null ? 100 : o.minPaise;
    const maxPaise = num(o.maxPaise) === null ? 100000000 : o.maxPaise; // ₹10,00,000 ceiling
    const stepPaise = num(o.stepPaise) === null ? 100 : o.stepPaise;

    if (typeof valueFn !== 'function' || target === null) {
      return { feasible: false, pricePaise: null, reason: 'Solver needs a metric function and a target.', evaluations: 0 };
    }

    let evaluations = 0;
    const evalAt = p => { evaluations++; return valueFn(p); };

    const meets = v => v !== null && Number.isFinite(v) && v >= target;

    let prevP = minPaise;
    let prevV = evalAt(minPaise);
    if (meets(prevV)) {
      return { feasible: true, pricePaise: minPaise, verifiedValue: prevV, evaluations, note: 'Target already met at the lowest tested price.' };
    }
    let lastV = prevV;
    for (let p = minPaise + stepPaise; p <= maxPaise; p += stepPaise) {
      const v = evalAt(p);
      lastV = v;
      if (meets(v)) {
        let lo = prevP, hi = p;
        for (let k = 0; k < 40 && hi - lo > 1; k++) {
          const mid = Math.floor((lo + hi) / 2);
          const mv = evalAt(mid);
          if (meets(mv)) hi = mid; else lo = mid;
        }
        const verified = evalAt(hi);
        return {
          feasible: true,
          pricePaise: hi,
          verifiedValue: verified,
          evaluations,
          bracket: { from: prevP, to: p },
          note: 'Verified by re-evaluating the metric at the solved price.'
        };
      }
      prevP = p; prevV = v;
    }
    return {
      feasible: false,
      pricePaise: null,
      reason: 'No price up to ' + money.format(maxPaise) + ' reaches the target.',
      bestValueAtCeiling: lastV,
      ceilingPaise: maxPaise,
      evaluations
    };
  }

  /** Target helpers: the four goals the UI exposes. */
  function makeMetricFn(input, goal) {
    return function valueAtPrice(pricePaise) {
      const r = unitEconomics(Object.assign({}, input, { pricePaise }));
      if (r.business.contributionBeforeAdsPaise === null) return null;
      switch (goal.type) {
        case 'breakeven': return r.business.contributionBeforeAdsPaise;               // target = 0
        case 'profit': return r.business.contributionBeforeAdsPaise;                  // target = ₹ per unit
        case 'margin': return r.business.contributionMarginOnPricePct;                // target = % of price
        case 'roi': return r.business.roiOnProductCostPct;                            // target = % of product cost
        default: return null;
      }
    };
  }

  function targetPrice(input, goal) {
    const g = goal || { type: 'breakeven', value: 0 };
    const result = solvePrice(Object.assign({
      valueFn: makeMetricFn(input, g),
      target: g.type === 'breakeven' ? 0 : num(g.value)
    }, goal && goal.solver ? goal.solver : {}));

    if (!result.feasible) return Object.assign({ goal: g }, result);
    const at = unitEconomics(Object.assign({}, input, { pricePaise: result.pricePaise }));
    return Object.assign({ goal: g, result: at }, result);
  }

  /** Discount scenarios that re-run the whole fee + tax + profit stack per price. */
  function discountScenarios(options) {
    const o = options || {};
    const discounts = (o.discounts && o.discounts.length ? o.discounts : [5, 10, 15, 20]).slice();
    if (num(o.customDiscountPct) !== null) discounts.push(o.customDiscountPct);
    const basisPaise = o.basis === 'mrp' ? num(o.mrpPaise) : num(o.currentPricePaise);
    if (basisPaise === null) {
      return { basis: o.basis || 'current', rows: [], error: 'Need a base price (current price or MRP) to simulate discounts.' };
    }

    const baseAt = o.evaluate ? o.evaluate(basisPaise) : null;
    const rows = discounts.map(pct => {
      const finalPrice = Math.max(0, Math.round(basisPaise * (100 - pct) / 100));
      const r = o.evaluate ? o.evaluate(finalPrice) : null;
      const contribution = r && r.business ? r.business.contributionBeforeAdsPaise : null;
      const baseContribution = baseAt && baseAt.business ? baseAt.business.contributionBeforeAdsPaise : null;
      return {
        discountPct: pct,
        finalPricePaise: finalPrice,
        discountAmountPaise: basisPaise - finalPrice,
        marketplaceChargesPaise: r && r.components ? r.components.marketplaceChargesPaise : null,
        settlementPaise: r && r.cash ? r.cash.settlementPaise : null,
        contributionBeforeAdsPaise: contribution,
        contributionMarginPct: r && r.business ? r.business.contributionMarginOnPricePct : null,
        roiPct: r && r.business ? r.business.roiOnProductCostPct : null,
        deltaVsCurrentPaise: contribution !== null && baseContribution !== null ? contribution - baseContribution : null,
        profitable: contribution === null ? null : contribution > 0,
        feesComplete: r && r.fees ? r.fees.complete : null
      };
    });

    return {
      basis: o.basis || 'current',
      basisPaise,
      rows,
      warning: rows.some(r => r.profitable === false)
        ? 'At least one discount level sells below your modelled cost — those rows lose money on every delivered order.'
        : null,
      caveat: 'Marketplace charges are recomputed for each discounted price, including price bands and percentage fees. ' +
        'Platform-funded discounts are not assumed: enter them explicitly if the marketplace funds part of the discount.'
    };
  }

  /** Advertising metrics. Never invents attributed sales. */
  function advertisingMetrics(input) {
    const i = input || {};
    const spend = num(i.spendPaise);
    const revenue = num(i.attributedRevenuePaise);
    const orders = num(i.attributedOrders);
    const clicks = num(i.clicks);
    const contributionPerOrder = num(i.contributionBeforeAdsPerOrderPaise);
    const notes = [];
    const out = {
      spendPaise: spend, attributedRevenuePaise: revenue, attributedOrders: orders, clicks: clicks,
      acosPct: null, roas: null, costPerOrderPaise: null, costPerClickPaise: null,
      breakEvenRoas: null, breakEvenAcosPct: null, contributionAfterAdsPaise: null,
      notes, missing: []
    };

    if (spend === null) out.missing.push({ key: 'spendPaise', label: 'Advertising spend', why: 'Enter spend for the period' });
    if (revenue === null) out.missing.push({ key: 'attributedRevenuePaise', label: 'Attributed sales', why: 'Use the sales figure reported by the ad platform — it is not estimated here' });
    if (orders === null) out.missing.push({ key: 'attributedOrdersPaise', label: 'Attributed orders', why: 'Optional, but needed for cost per order' });

    if (spend !== null && revenue !== null) {
      if (revenue === 0) {
        notes.push('Attributed sales are zero, so ACOS/ROAS are undefined rather than infinite.');
      } else {
        out.acosPct = (spend / revenue) * 100;
        out.roas = revenue / spend;
      }
    }
    if (spend !== null && orders !== null && orders > 0) out.costPerOrderPaise = spend / orders;
    if (spend !== null && clicks !== null && clicks > 0) out.costPerClickPaise = spend / clicks;

    if (contributionPerOrder !== null && contributionPerOrder > 0 && revenue !== null && orders && orders > 0) {
      const revenuePerOrder = revenue / orders;
      out.breakEvenRoas = revenuePerOrder / contributionPerOrder;
      out.breakEvenAcosPct = (contributionPerOrder / revenuePerOrder) * 100;
      notes.push('Break-even ROAS uses the contribution before advertising per order in the same revenue basis as the attributed sales.');
    } else if (contributionPerOrder !== null && contributionPerOrder <= 0) {
      notes.push('Contribution before advertising is zero or negative — no amount of advertising is profitable at these costs.');
    } else {
      out.missing.push({ key: 'contributionBeforeAdsPerOrderPaise', label: 'Contribution before advertising', why: 'Complete the Profit & Settlement inputs first' });
    }

    if (spend !== null && orders !== null && orders > 0 && contributionPerOrder !== null) {
      out.contributionAfterAdsPaise = contributionPerOrder * orders - spend;
    } else if (spend !== null && contributionPerOrder !== null) {
      out.contributionAfterAdsPaise = contributionPerOrder - spend;
      notes.push('Cost per attributed order unavailable: the whole spend is charged against a single order.');
    }

    notes.push('ROAS and ACOS come from revenue, not profit. Compare ACOS against the contribution margin, not against gross sales.');
    return out;
  }

  /** Return / RTO scenario table. */
  function returnSensitivity(input) {
    const i = input || {};
    const rates = i.rates || [0, 2, 5, 8, 12, 20];
    const lossPerReturn = num(i.lossPerReturnPaise);
    const lossPerRto = num(i.lossPerRtoPaise);
    const baseBeforeAds = num(i.contributionBeforeAdsExReturnPaise);
    const missing = [];
    if (lossPerReturn === null) missing.push({ key: 'lossPerReturnPaise', label: 'Loss per returned order', why: 'Required to model returns' });
    if (lossPerRto === null) missing.push({ key: 'lossPerRtoPaise', label: 'Loss per RTO order', why: 'Required to model RTOs' });
    if (baseBeforeAds === null) missing.push({ key: 'contributionBeforeAdsExReturnPaise', label: 'Contribution before returns', why: 'Complete the unit economics first' });

    const rows = rates.map(r => {
      const returnRate = r;
      const rtoRate = num(i.rtoRatePct) === null ? r / 2 : i.rtoRatePct; // explicit assumption, labelled
      const provision = (lossPerReturn === null || baseBeforeAds === null)
        ? null
        : money.pctOf(money.roundHalfAwayFromZero(lossPerReturn), returnRate) +
          (lossPerRto === null ? 0 : money.pctOf(money.roundHalfAwayFromZero(lossPerRto), rtoRate));
      return {
        returnRatePct: returnRate,
        rtoRatePct: rtoRate,
        provisionPaise: provision,
        contributionBeforeAdsPaise: provision === null ? null : baseBeforeAds - provision,
        note: num(i.rtoRatePct) === null ? 'RTO rate assumed at half the return rate — change it in the inputs.' : null
      };
    });
    return { rows, missing, caveat: 'Rates are your assumptions. Replace them with your own order history when you have it.' };
  }

  /** Monthly forecast with three explicitly-labelled scenarios. */
  function monthlyForecast(input) {
    const i = input || {};
    const baseOrders = num(i.ordersPerMonth);
    if (baseOrders === null) {
      return { rows: [], missing: [{ key: 'ordersPerMonth', label: 'Orders per month', why: 'Enter the volume you want to forecast' }] };
    }
    const scenarios = i.scenarios || {
      conservative: { volumeMultiplier: 0.6, note: 'Volume 40% below the entered volume' },
      base: { volumeMultiplier: 1, note: 'Exactly the volume you entered' },
      optimistic: { volumeMultiplier: 1.4, note: 'Volume 40% above the entered volume' }
    };

    const unitAt = i.unitAt; // function(orders) -> unit economics result (volume never changes per-unit fees, but kept flexible)
    const rows = [];
    for (const key of Object.keys(scenarios)) {
      const s = scenarios[key];
      const orders = Math.max(0, Math.round(baseOrders * s.volumeMultiplier));
      const unit = typeof unitAt === 'function' ? unitAt(orders) : null;
      if (!unit) { rows.push({ scenario: key, orders, note: s.note, unavailable: true }); continue; }
      const b = unit.business || {};
      const c = unit.components || {};
      const deliveredFraction = (() => {
        const rr = num(i.returnRatePct), tr = num(i.rtoRatePct);
        if (rr === null || tr === null) return null;
        return Math.max(0, 1 - (rr + tr) / 100);
      })();
      const deliveredOrders = deliveredFraction === null ? null : Math.round(orders * deliveredFraction);
      const netRevenue = b.netSalesRevenuePaise === null ? null : b.netSalesRevenuePaise * orders;
      const grossSales = unit.grossRevenuePaise === null ? null : unit.grossRevenuePaise * orders;
      const marketplaceCharges = c.marketplaceChargesPaise === null ? null : c.marketplaceChargesPaise * orders;
      const settlements = unit.cash && unit.cash.settlementPaise !== null ? unit.cash.settlementPaise * orders : null;
      const cogs = c.productCostPaise === null ? null : c.productCostPaise * orders;
      const packaging = (c.prepCostsPaise || 0) * orders;
      const ads = c.adsPerOrderPaise === null ? null : c.adsPerOrderPaise * orders;
      const returnLoss = c.returnProvisionPaise === null ? null : c.returnProvisionPaise * orders;
      const contribution = b.contributionBeforeAdsPaise === null ? null : b.contributionBeforeAdsPaise * orders;
      const fixed = c.fixedMonthlyPaise === null ? null : c.fixedMonthlyPaise;
      const operating = (contribution === null || fixed === null) ? null : contribution - fixed;
      rows.push({
        scenario: key, note: s.note, orders, deliveredOrders, grossSalesPaise: grossSales,
        netRevenuePaise: netRevenue, marketplaceChargesPaise: marketplaceCharges,
        settlementsPaise: settlements, cogsPaise: cogs, packagingPaise: packaging,
        adsPaise: ads, returnLossPaise: returnLoss, contributionPaise: contribution,
        fixedPaise: fixed, operatingProfitPaise: operating,
        inventoryInvestmentPaise: cogs === null ? null : cogs + packaging,
        cashNeededPaise: cogs === null ? null : (cogs + packaging + (fixed || 0))
      });
    }
    return {
      rows,
      caveat: 'Scenario multipliers are assumptions, not forecasts from your sales history. Forecasts are only as good as the volume you enter.',
      missing: []
    };
  }

  return {
    unitEconomics, solvePrice, targetPrice, makeMetricFn, discountScenarios,
    advertisingMetrics, returnSensitivity, monthlyForecast, suggestReturnLoss
  };
});
