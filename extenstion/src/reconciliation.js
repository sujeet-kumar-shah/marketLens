// MarketLens core module: reconciliation.js
// Compare a marketplace settlement statement against the components the seller
// entered. The engine NEVER adjusts a component to force agreement: it reports
// the difference and lists the plausible causes for the seller to check.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.recon = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const money = require_ ? require_('./money.js') : globalThis.MarketLens.money;

  /**
   * components: [{ label, amountPaise, sign: 'credit'|'charge', kind?: 'fee'|'tax'|'logistics'|'other' }]
   * Returns the arithmetic result and a full audit of the difference.
   */
  function reconcile(input) {
    const i = input || {};
    const components = (i.components || []).map(c => ({
      label: c.label || c.kind || 'component',
      kind: c.kind || 'other',
      sign: c.sign === 'credit' ? 'credit' : 'charge',
      amountPaise: c.amountPaise === null || c.amountPaise === undefined ? null : c.amountPaise,
      known: c.amountPaise !== null && c.amountPaise !== undefined
    }));

    const pricePaise = i.pricePaise === undefined ? null : i.pricePaise;
    const claimed = i.claimedSettlementPaise === undefined ? null : i.claimedSettlementPaise;
    const tolerancePaise = i.tolerancePaise === undefined ? 50 : i.tolerancePaise; // default ₹0.50

    const unknown = components.filter(c => !c.known);
    const credits = money.sumOrZero(components.filter(c => c.sign === 'credit' && c.known).map(c => c.amountPaise));
    const charges = money.sumOrZero(components.filter(c => c.sign === 'charge' && c.known).map(c => c.amountPaise));

    // Any non-price component given as a credit is added to the sale value.
    const basePrice = pricePaise === null
      ? money.sumOrZero(components.filter(c => c.kind === 'price' && c.known).map(c => c.amountPaise))
      : pricePaise;

    const expectedSettlement = basePrice - charges + credits;
    const difference = claimed === null ? null : expectedSettlement - claimed;
    const absDifference = difference === null ? null : Math.abs(difference);
    const differencePct = (claimed && difference !== null) ? (difference / claimed) * 100 : null;
    const withinTolerance = absDifference === null ? null : absDifference <= tolerancePaise;

    const flags = [];

    // No claim entered (absent or explicitly null): say so instead of comparing
    // against an implied zero. The flag is always emitted so the UI can show that
    // agreement was simply not checked.
    if (claimed === null) {
      flags.push({ level: 'info', code: 'no_claim', message: 'Enter the settlement amount your statement shows to check the components against it.' });
    }

    if (difference !== null && difference !== 0) {
      if (withinTolerance) {
        flags.push({
          level: 'warn', code: 'rounding',
          message: 'The difference is ' + money.format(absDifference) + ', within your tolerance of ' + money.format(tolerancePaise) +
            '. This is consistent with rounding (per-component rounding up/down) or a paise-level transcription difference — but it is still shown, not hidden.'
        });
      } else {
        flags.push({
          level: 'bad',
          code: difference > 0 ? 'expected_more' : 'expected_less',
          message: difference > 0
            ? 'Your components add up to ' + money.format(absDifference) + ' MORE than the statement. A deduction exists that is not in the list, or one deduction is counted twice, or a credit is missing.'
            : 'Your components add up to ' + money.format(absDifference) + ' LESS than the statement. A charge may be missing from the statement total, or a component was mis-typed.'
        });
      }
    }

    // Duplicate detection: same label / kind appearing more than once with a value.
    const seen = new Map();
    for (const c of components.filter(c => c.known && c.kind !== 'price')) {
      const key = c.label.toLowerCase().trim();
      if (seen.has(key)) {
        flags.push({
          level: 'warn', code: 'duplicate',
          message: '“' + c.label + '” appears more than once (' + money.format(seen.get(key)) + ' and ' + money.format(c.amountPaise) +
            '). Marketplaces sometimes list commission and GST on commission separately — check that GST is not deducted twice.'
        });
      } else {
        seen.set(key, c.amountPaise);
      }
    }

    // Tax-handling checks.
    const hasGstLine = components.some(c => /gst|tax/i.test(c.label));
    const hasCommission = components.some(c => /commission/i.test(c.label));
    if (hasGstLine && !hasCommission) {
      flags.push({ level: 'warn', code: 'tax_without_base', message: 'A tax/GST line is present without the fee it is charged on. Enter the underlying fee so the GST base can be checked.' });
    }
    const gstLines = components.filter(c => /gst/i.test(c.label) && c.known);
    if (gstLines.length > 1) {
      flags.push({ level: 'info', code: 'multi_gst', message: 'More than one GST line detected. Confirm the marketplace has not bundled GST on services into a combined fee as well.' });
    }

    if (unknown.length) {
      flags.push({
        level: 'warn', code: 'unknown_components',
        message: unknown.length + ' component(s) have no amount: ' + unknown.map(c => c.label).join(', ') + '. The comparison covers the entered values only.'
      });
    }

    const checkedComponents = components.length > 0;
    return {
      pricePaise: basePrice,
      components,
      unknownComponents: unknown,
      creditsPaise: credits,
      chargesPaise: charges,
      expectedSettlementPaise: expectedSettlement,
      claimedSettlementPaise: claimed,
      differencePaise: difference,
      absoluteDifferencePaise: absDifference,
      differencePct,
      tolerancePaise,
      withinTolerance,
      agreement: difference === null ? 'not_checked' : (difference === 0 ? 'exact' : (withinTolerance ? 'within_tolerance' : 'mismatch')),
      flags,
      checkedComponents,
      disclaimer: 'This is arithmetic on the numbers you entered. It is not a substitute for the marketplace settlement report and it never changes your inputs.'
    };
  }

  /** Convenience: the documented ₹797 fixture used in the test suite. */
  function fixture797() {
    return {
      pricePaise: 79700,
      claimedSettlementPaise: 57600,
      tolerancePaise: 100,
      components: [
        { label: 'Marketplace fee', kind: 'fee', sign: 'charge', amountPaise: 4500 },
        { label: 'Taxes shown', kind: 'tax', sign: 'charge', amountPaise: 1100 },
        { label: 'Customer logistics fee', kind: 'logistics', sign: 'charge', amountPaise: 16400 }
      ]
    };
  }

  return { reconcile, fixture797 };
});
