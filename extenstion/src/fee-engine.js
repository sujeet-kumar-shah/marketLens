// MarketLens core module: fee-engine.js
// Component-based marketplace charge calculation driven by versioned rules.
//
// Guarantees
// ----------
//  * A charge with no usable rule is reported as `missing` — never as ₹0.
//  * Two equally specific rules with different outcomes are reported as a
//    `conflict` — the engine refuses to pick one silently.
//  * Every computed component carries the rule id, its provenance and its
//    verification status so the UI can attribute it.
//  * All money is integer paise.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.fees = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const money = require_ ? require_('./money.js') : globalThis.MarketLens.money;
  const rules = require_ ? require_('./platform-rules.js') : globalThis.MarketLens.rules;

  const STATUS_OK = 'computed';
  const STATUS_MISSING = 'missing';
  const STATUS_CONFLICT = 'conflict';
  const STATUS_NA = 'not_applicable';

  /** Volumetric weight in grams using a cm-based divisor (default 5000). */
  function volumetricWeightG(dimsCm, divisor) {
    if (!dimsCm || !dimsCm.l || !dimsCm.w || !dimsCm.h) return null;
    const d = divisor || rules.DEFAULTS.volumetricDivisor;
    if (!d) return null;
    return Math.round(((dimsCm.l * dimsCm.w * dimsCm.h) / d) * 1000);
  }

  function inPriceBand(rule, pricePaise) {
    if (!rule.priceBand) return true;
    const min = rule.priceBand.minPaise === null || rule.priceBand.minPaise === undefined ? 0 : rule.priceBand.minPaise;
    const max = rule.priceBand.maxPaise === null || rule.priceBand.maxPaise === undefined ? Infinity : rule.priceBand.maxPaise;
    if (pricePaise === null || pricePaise === undefined) return false;
    return pricePaise >= min && pricePaise < max;
  }

  function contextMatches(rule, ctx) {
    if (rule.marketplace !== ctx.marketplace) return false;
    if (rule.category && ctx.category && rule.category !== String(ctx.category).toLowerCase()) return false;
    if (rule.category && !ctx.category) return false;   // category-specific rule needs a known category
    if (rule.subcategory && (!ctx.subcategory || rule.subcategory !== String(ctx.subcategory).toLowerCase())) return false;
    if (rule.fulfilment && rule.fulfilment !== (ctx.fulfilment || '')) return false;
    if (rule.fulfilment && !ctx.fulfilment) return false; // needs a known fulfilment method
    if (rule.zone && rule.zone !== (ctx.zone || '')) return false;
    if (!rules.isEffective(rule, ctx.asOfDate)) return false;
    return true;
  }

  function seriesKey(rule) {
    return [
      rule.feeType, rule.category || '*', rule.subcategory || '*',
      rule.fulfilment || '*', rule.zone || '*',
      rule.provenance || 'unverified', rule.sellerOverride ? 'override' : 'std'
    ].join('|');
  }

  function pickWeightBand(series, weightG) {
    if (weightG === null || weightG === undefined) return { rule: null, reason: 'chargeable weight unknown' };
    let best = null;
    for (const rule of series) {
      const band = rule.weightBandG;
      if (!band) { best = rule; continue; }
      const min = band.minG === null || band.minG === undefined ? 0 : band.minG;
      const max = band.maxG === null || band.maxG === undefined ? Infinity : band.maxG;
      if (weightG >= min && weightG < max) return { rule, reason: null };
      if (max === Infinity && weightG >= min) return { rule, reason: null };
    }
    return { rule: best, reason: best ? null : 'no weight band covers ' + Math.round(weightG / 1000 * 10) / 10 + ' kg' };
  }

  function pickPriceBand(series, pricePaise) {
    for (const rule of series) {
      if (inPriceBand(rule, pricePaise)) return rule;
    }
    return null;
  }

  function clampFee(amountPaise, rule) {
    let amount = amountPaise;
    const notes = [];
    if (rule.minFeePaise !== null && rule.minFeePaise !== undefined && amount < rule.minFeePaise) {
      notes.push('raised to the rule minimum ' + money.format(rule.minFeePaise));
      amount = rule.minFeePaise;
    }
    if (rule.maxFeePaise !== null && rule.maxFeePaise !== undefined && amount > rule.maxFeePaise) {
      notes.push('capped at the rule maximum ' + money.format(rule.maxFeePaise));
      amount = rule.maxFeePaise;
    }
    return { amount, notes };
  }

  function computeComponent(feeType, series, ctx) {
    const rep = series[0];
    const kind = (rules.FEE_TYPES[feeType] || {}).kind || 'fixed';
    const sign = (rules.FEE_TYPES[feeType] || {}).sign || 'charge';
    const base = {
      feeType, label: rep.label, sign,
      ruleId: rep.id, provenance: rep.provenance, verification: rep.verification,
      source: rep.sourceUrl, note: rep.note, ruleVersion: rep.version,
      lastVerifiedAt: rep.lastVerifiedAt
    };

    // Rate not entered anywhere in this series -> do not guess.
    const anyRate = series.some(r => rules.numOrNull(r.ratePct) !== null || r.fixedPaise !== null);
    if (!anyRate) {
      return Object.assign({}, base, {
        status: STATUS_MISSING, amountPaise: null,
        reason: 'no rate on file — enter your ' + rep.label.toLowerCase() + ' from your rate card'
      });
    }

    let rule = rep;
    if (kind === 'slab_weight' || rep.basis === 'weight') {
      const chargeRule = series.find(r => r.weightBandG) || rep;
      const volG = volumetricWeightG(ctx.packedDimsCm, chargeRule.divisor || rules.DEFAULTS.volumetricDivisor);
      let chargeable = ctx.actualWeightG;
      const caveats = [];
      if (chargeRule.chargeableWeight === 'max_actual_volumetric' || chargeRule.divisor) {
        if (ctx.actualWeightG !== null && volG !== null) {
          chargeable = Math.max(ctx.actualWeightG, volG);
        } else if (ctx.actualWeightG === null && volG !== null) {
          chargeable = volG;
          caveats.push('actual packed weight missing — using volumetric weight only');
        } else if (ctx.actualWeightG !== null && volG === null) {
          chargeable = ctx.actualWeightG;
          caveats.push('packed dimensions missing — volumetric weight not applied, charge may be higher');
        } else {
          return Object.assign({}, base, {
            status: STATUS_MISSING, amountPaise: null,
            reason: 'needs packed weight and/or packed dimensions (L×W×H cm)'
          });
        }
      }
      const picked = pickWeightBand(series.filter(r => r.weightBandG).length ? series : [rep], chargeable);
      if (!picked.rule) {
        return Object.assign({}, base, { status: STATUS_MISSING, amountPaise: null, reason: picked.reason });
      }
      rule = picked.rule;
      let amount = rule.fixedPaise === null ? 0 : rule.fixedPaise;
      const band = rule.weightBandG;
      if (band && rule.perKgBeyondPaise !== null && rule.perKgBeyondPaise !== undefined) {
        // A band with no upper limit is read as "base fee up to minG, then per kg beyond minG".
        const thresholdG = (band.maxG === null || band.maxG === undefined) ? band.minG : band.maxG;
        if (thresholdG !== null && thresholdG !== undefined && chargeable > thresholdG) {
          const extraKg = Math.ceil((chargeable - thresholdG) / 1000);
          amount += extraKg * rule.perKgBeyondPaise;
          caveats.push('includes ' + extraKg + ' extra kg beyond ' + (thresholdG / 1000) + ' kg');
        }
      }
      if (band && band.maxG !== null && band.maxG !== undefined && rule.perKgBeyondPaise === null && chargeable > band.maxG) {
        caveats.push('chargeable weight exceeds the last entered band (' + (band.maxG / 1000) + ' kg) — add the next slab from your rate card');
      }
      const clamped = clampFee(amount, rule);
      return Object.assign({}, base, {
        status: STATUS_OK, amountPaise: clamped.amount, ruleId: rule.id,
        provenance: rule.provenance, verification: rule.verification, note: rule.note || rep.note,
        detail: {
          chargeableWeightG: chargeable, actualWeightG: ctx.actualWeightG, volumetricWeightG: volG,
          divisor: rule.divisor, band: band, caveats: caveats.concat(clamped.notes)
        }
      });
    }

    if (kind === 'slab' || (series.length > 1 && series.some(r => r.priceBand))) {
      const r = pickPriceBand(series, ctx.pricePaise);
      if (!r) {
        return Object.assign({}, base, {
          status: STATUS_MISSING, amountPaise: null,
          reason: 'no price band covers ' + money.format(ctx.pricePaise) + ' — add the band from your rate card'
        });
      }
      rule = r;
    }

    let amount = 0;
    const detail = { base: null, ratePct: rule.ratePct };
    if (kind === 'percent') {
      if (rep.basis === 'fees_subtotal') {
        // Deferred: the base is the sum of the other marketplace service fees,
        // which is only known after every other component has been computed.
        if (rule.ratePct === null || rule.ratePct === undefined) {
          return Object.assign({}, base, { status: STATUS_MISSING, amountPaise: null, reason: 'percentage rate not entered' });
        }
        return Object.assign({}, base, {
          status: STATUS_OK, amountPaise: 0, ruleId: rule.id,
          detail: { base: 'taxable marketplace service fees (excluding GST)', deferred: true, ratePct: rule.ratePct }
        });
      }
      let priceBase = ctx.pricePaise;
      if (rep.basis === 'price' && ctx.commissionBase === 'net_of_seller_discount' && ctx.sellerFundedDiscountPaise) {
        priceBase = ctx.pricePaise - ctx.sellerFundedDiscountPaise;
        detail.base = 'price after seller-funded discount';
      } else {
        detail.base = 'selling price';
      }
      if (rule.ratePct === null || rule.ratePct === undefined) {
        return Object.assign({}, base, { status: STATUS_MISSING, amountPaise: null, reason: 'percentage rate not entered' });
      }
      const feeBase = rep.basis === 'price' ? priceBase : null;
      if (feeBase === null) {
        return Object.assign({}, base, { status: STATUS_MISSING, amountPaise: null, reason: 'unknown calculation base' });
      }
      if (feeBase === null || feeBase === undefined) {
        return Object.assign({}, base, { status: STATUS_MISSING, amountPaise: null, reason: 'selling price unknown' });
      }
      detail.baseAmountPaise = feeBase;
      amount = money.pctOf(feeBase, rule.ratePct);
    } else {
      if (rule.fixedPaise === null || rule.fixedPaise === undefined) {
        return Object.assign({}, base, { status: STATUS_MISSING, amountPaise: null, reason: 'fixed amount not entered' });
      }
      amount = rule.fixedPaise;
      detail.base = 'fixed amount';
      if (rep.quantityMultiplier && ctx.quantity) amount = rule.fixedPaise * ctx.quantity;
    }

    const clamped = clampFee(amount, rule);
    detail.caveats = clamped.notes;
    return Object.assign({}, base, { status: STATUS_OK, amountPaise: clamped.amount, ruleId: rule.id, detail });
  }

  /**
   * Compute every applicable marketplace charge for one unit.
   *
   * ctx = {
   *   marketplace, category, subcategory, fulfilment, zone, asOfDate,
   *   pricePaise, sellerFundedDiscountPaise,
   *   actualWeightG, packedDimsCm, quantity, commissionBase
   * }
   */
  function computeFees(ctx, ruleList, options) {
    const o = options || {};
    const context = Object.assign({
      quantity: 1, commissionBase: 'price', sellerFundedDiscountPaise: 0
    }, ctx || {});
    const mp = rules.marketplace(context.marketplace);
    const applicable = rules.applicableFeeTypes(context.marketplace, context.fulfilment);
    const pool = (ruleList || []).filter(r => r && r.marketplace === context.marketplace);

    const components = [];
    const missing = [];
    const conflicts = [];
    const notApplicable = [];
    const notes = [];

    if (mp.capabilities.feeModel === 'not_implemented' && !mp.capabilities.profitModel) {
      notes.push('No fee model is implemented for ' + mp.label + '. Everything below must come from your own rate card entries.');
    }

    for (const feeType of applicable) {
      let candidates = pool.filter(r => r.feeType === feeType && contextMatches(r, context));

      if (!candidates.length) {
        components.push({
          feeType, label: (rules.FEE_TYPES[feeType] || {}).label || feeType,
          sign: (rules.FEE_TYPES[feeType] || {}).sign || 'charge',
          status: STATUS_MISSING, amountPaise: null, provenance: null, verification: 'missing',
          reason: 'no rule matches this product (marketplace/category/fulfilment) — enter your rate'
        });
        missing.push({ feeType, reason: 'no matching rule' });
        continue;
      }

      // Group into deterministic series and choose the most specific.
      const bySeries = new Map();
      for (const r of candidates) {
        const key = seriesKey(r);
        if (!bySeries.has(key)) bySeries.set(key, []);
        bySeries.get(key).push(r);
      }

      // Inside one series, rules that cover the SAME band but carry different
      // amounts are a contradiction: report it instead of picking one.
      for (const list of bySeries.values()) {
        const byBand = new Map();
        for (const r of list) {
          const bk = JSON.stringify([r.priceBand || null, r.weightBandG || null]);
          if (!byBand.has(bk)) byBand.set(bk, []);
          byBand.get(bk).push(r);
        }
        for (const sameBand of byBand.values()) {
          if (sameBand.length < 2) continue;
          const sig = r => JSON.stringify([r.ratePct, r.fixedPaise, r.perKgBeyondPaise, r.minFeePaise, r.maxFeePaise]);
          const distinct = new Set(sameBand.map(sig));
          if (distinct.size > 1) {
            const [a, b] = sameBand;
            conflicts.push({
              feeType, label: a.label,
              candidates: [{ ruleId: a.id, ratePct: a.ratePct, fixedPaise: a.fixedPaise }, { ruleId: b.id, ratePct: b.ratePct, fixedPaise: b.fixedPaise }],
              message: 'Rules “' + a.id + '” and “' + b.id + '” cover the same product with different amounts. Confirm which rate applies before trusting the total.'
            });
            components.push({
              feeType, label: a.label, sign: (rules.FEE_TYPES[feeType] || {}).sign || 'charge',
              status: STATUS_CONFLICT, amountPaise: null, ruleId: a.id,
              provenance: a.provenance, verification: 'unverified',
              reason: conflicts[conflicts.length - 1].message
            });
            break;
          }
        }
        if (components.some(c => c.feeType === feeType && c.status === STATUS_CONFLICT)) break;
      }
      if (components.some(c => c.feeType === feeType && c.status === STATUS_CONFLICT)) continue;

      const seriesList = [...bySeries.values()].map(list => {
        const sorted = list.slice().sort((a, b) => rules.specificity(b) - rules.specificity(a));
        return { rules: sorted, score: rules.specificity(sorted[0]) };
      }).sort((a, b) => b.score - a.score);

      const top = seriesList[0];
      const tie = seriesList[1];
      if (tie && tie.score === top.score && o.reportConflicts !== false) {
        const a = computeComponent(feeType, top.rules, context);
        const b = computeComponent(feeType, tie.rules, context);
        if (a.status === STATUS_OK && b.status === STATUS_OK && a.amountPaise !== b.amountPaise) {
          const conflict = {
            feeType, label: a.label,
            candidates: [
              { ruleId: a.ruleId, amountPaise: a.amountPaise },
              { ruleId: b.ruleId, amountPaise: b.amountPaise }
            ],
            message: 'Two equally specific rules disagree (' +
              money.format(a.amountPaise) + ' vs ' + money.format(b.amountPaise) +
              '). Confirm which rate applies before trusting the total.'
          };
          conflicts.push(conflict);
          components.push({
            feeType, label: a.label, sign: a.sign, status: STATUS_CONFLICT, amountPaise: null,
            ruleId: a.ruleId, provenance: a.provenance, verification: 'unverified',
            reason: conflict.message, candidates: conflict.candidates
          });
          continue;
        }
      }

      const component = computeComponent(feeType, top.rules, context);
      components.push(component);
      if (component.status === STATUS_MISSING) missing.push({ feeType, reason: component.reason });
    }

    // Unused applicable fee types (e.g. seller-only fees on a marketplace that does not use them)
    for (const feeType of Object.keys(rules.FEE_TYPES)) {
      if (applicable.indexOf(feeType) > -1) continue;
      const hasRules = pool.some(r => r.feeType === feeType && contextMatches(r, context));
      if (hasRules) notApplicable.push({ feeType, reason: 'not used for this fulfilment method in this build' });
    }

    // GST on marketplace services is computed on the taxable service fees (charges,
    // excluding itself and excluding pass-through credits).
    const gstComponent = components.find(c => c.feeType === 'gst_on_services');
    if (gstComponent && gstComponent.status === STATUS_OK) {
      const serviceSubtotal = money.sumOrZero(components
        .filter(c => c.feeType !== 'gst_on_services' && c.sign === 'charge' && c.status === STATUS_OK)
        .map(c => c.amountPaise));
      const gstRule = pool.find(r => r.feeType === 'gst_on_services') || null;
      const rate = gstRule && rules.numOrNull(gstRule.ratePct) !== null ? gstRule.ratePct : rules.DEFAULTS.gstOnMarketplaceServicesPct;
      gstComponent.amountPaise = money.pctOf(serviceSubtotal, rate);
      gstComponent.detail = { base: 'taxable marketplace service fees (excluding GST)', baseAmountPaise: serviceSubtotal, ratePct: rate };
      gstComponent.verification = (gstRule && gstRule.verification) || 'unverified';
      gstComponent.ruleId = (gstRule && gstRule.id) || gstComponent.ruleId;
    }

    const computed = components.filter(c => c.status === STATUS_OK);
    const charges = money.sumOrZero(computed.filter(c => c.sign === 'charge').map(c => c.amountPaise));
    const credits = money.sumOrZero(computed.filter(c => c.sign === 'credit').map(c => c.amountPaise));

    const provenanceCounts = { seller: 0, structure: 0, unverified: 0 };
    for (const c of computed) {
      if (c.provenance === 'seller') provenanceCounts.seller++;
      else if (c.provenance === 'structure') provenanceCounts.structure++;
      else provenanceCounts.unverified++;
    }

    const complete = missing.length === 0 && conflicts.length === 0;

    return {
      marketplace: context.marketplace,
      fulfilment: context.fulfilment || null,
      pricePaise: context.pricePaise,
      chargeableWeightG: (() => {
        const vol = volumetricWeightG(context.packedDimsCm, rules.DEFAULTS.volumetricDivisor);
        if (context.actualWeightG !== null && context.actualWeightG !== undefined && vol !== null) return Math.max(context.actualWeightG, vol);
        return context.actualWeightG !== null && context.actualWeightG !== undefined ? context.actualWeightG : vol;
      })(),
      components,
      missing, conflicts, notApplicable, notes,
      totals: {
        chargesPaise: charges,
        creditsPaise: credits,
        netChargePaise: charges - credits,
        gstOnServicesPaise: gstComponent && gstComponent.status === STATUS_OK ? gstComponent.amountPaise : null
      },
      complete,
      provenanceCounts,
      allVerified: complete && computed.every(c => c.verification === 'verified_source' || c.verification === 'seller_confirmed' || c.verification === 'from_statement')
    };
  }

  return { computeFees, volumetricWeightG, VOLUMETRIC_DIVISOR_DEFAULT: rules.DEFAULTS.volumetricDivisor };
});
