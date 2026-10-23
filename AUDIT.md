# MarketLens v1 → v2: Audit

Scope: every file that existed in v1 (`../extenstion-v1-backup/v1/` keeps the pristine copies). Format: the problem, where it lived, why it was wrong, the seller impact, the correction, and the test that locks the correction.

---

## A. Fabricated data — the most serious class of bug

**A1. Monthly sales estimates were random numbers.**
`../extenstion-v1-backup/v1/content.js :: estimateMonthlySales(data)` (lines 248–265) returned `Math.floor(Math.random() * …)` ranges driven by review counts, and a second branch was driven by a "rank" that was itself random. A seller could price, stock and advertise against a number that changed on every page view and was never evidence.
**Correction:** deleted. v2 first added `src/sales-estimator.js` (it refused to output a number unless it had ≥2 timestamped review-count observations spanning ≥14 days *and* a seller-stated conversion assumption), but it was never wired into the sidebar, so it was removed in the v2.3 cleanup — no modelled sales numbers ship at all today. Verified seller figures from your own reports remain the only trusted source.
**Tests:** the module's own test file was removed with it; the honesty rules it enforced (no number without evidence, verified data outranks modelling) live on in the fee/profit/reconciliation tests.

**A2. Price history was a random walk.**
`../extenstion-v1-backup/v1/content.js :: generatePriceHistory(currentPrice, days)` (295–308) generated a synthetic 90-day series (`Math.random()`-driven ±8% steps) and the UI charted it as if observed.
**Correction:** deleted. `src/price-history.js` stores only genuine observations, deduplicates (6-hour same-price window; a review-count move is still stored), and `historyStatus()` says “never invents history” when the series is empty. An empty chart stays empty and says why.
**Tests:** `tests/research.test.js` (price-history section).

**A3. Keyword volume / difficulty / rank were random and unstable.**
`../extenstion-v1-backup/v1/content.js :: generateKeywords` (310–320) and the keyword panel in `bindTabEvents` (1093–1103) drew random volume/difficulty/rank *on every render*, so the same keyword showed different numbers each time. `../extenstion-v1-backup/v1/popup.js` shipped static `TRENDING_CATEGORIES` / `HOT_KEYWORDS` tables presented as “top growing” data.
**Correction:** all removed. The v2 Keywords tab shows (a) mechanical n-gram candidates from the listing’s own title, clearly labelled as a mechanical split with no volume data, and (b) samples the seller actually scanned and saved. The popup states there is no search-volume data and none is estimated.
**Tests:** UI behaviour documented; no fabricated numbers exist to test because the generators are deleted.

**A4. Marketplace fee presets were presented as platform facts.**
`../extenstion-v1-backup/v1/content.js :: PLATFORM_FEES` (746–756) hard-coded single-percent “known” fees (e.g. Flipkart 10% + ₹24 + ₹35 + ₹50/kg) used silently in every profit calculation.
**Correction:** `src/platform-rules.js` ships *structure* (which charges exist, how they are computed, GST-on-services base, volumetric divisor) only. No example rates and no marketplace fee rates ship at all; every fee comes from the seller’s rate card. A fee with no entered rate is reported `missing` — never ₹0.
**Tests:** `tests/fee-engine.test.js` (tests 11–26).

---

## B. Financial-correctness bugs

**B1. Return cost was the entire selling price.**
`calcProfitData` (774): `returnCost = sellPrice * returnRate / 100`. The real loss per return is reverse logistics + reshipment + damaged/unsellable stock — not the full price.
**Correction:** return provision = rate × seller-entered loss per return/RTO; `profit.suggestReturnLoss()` can propose reverse-logistics (from rules) + packaging, and states exactly what it omits (damaged inventory).
**Tests:** profit tests 38, 46, 47.

**B2. Break-even price double-counted COGS and was circular.**
`breakEvenSell = totalCosts + cogs + totalPlatform` (783) with `totalCosts` already containing COGS (775), and `returnCost` derived from the sell price being solved for.
**Correction:** `profit.solvePrice()` evaluates the whole fee + tax + profit stack at every candidate price (via `feeAtPrice`), scans at ₹1 steps, bisects to 1 paise, and re-verifies the result. Percentage fees, slabs, clamps and GST-on-services are handled; an unreachable target is reported, never approximated into existence.
**Tests:** profit tests 40 (within 30 paise of the analytic `32360 / 0.882`), 41 (impossible target reported instead of invented).

**B3. Contribution was labelled “Net Profit”.**
`netProfit = settlement − totalCosts` (779) is contribution, not net profit: it averages return cost, ignores fixed costs, and in v1 also depended on the fabricated fee presets. The UI called it “Net Profit — Actual profit after all deductions”.
**Correction:** three separate, correctly-named metrics: **cash settlement** (bank inflow), **business contribution** (revenue net of GST with ITC treatment), and **operating profit** (contribution − fixed, only with a volume). The phrase “net profit” is never used.
**Tests:** profit tests 33–37, 45.

**B4. Tax handling was a single “GST %” multiplier on fees.**
v1 added `gst` on fees but had no ITC treatment, no GST-inclusive vs exclusive handling, no TCS/TDS withholding, no exclusions list.
**Correction:** `src/tax-engine.js` separates output GST, ITC on fees/costs, TCS/TDS (withheld in cash, creditable later), and lists every unconfigured item as `excluded` with a reason plus a professional-review flag. The fee engine’s GST-on-services feeds the tax lines (base = other computed service charges, excluding itself).
**Tests:** `tests/fee-engine.test.js` test 16; profit tests 35–37.

**B5. `breakEvenUnits` mixed rupees and units.**
(782) `Math.ceil(|totalCosts| / Math.max(settlement − cogs, 0.01))` divides rupees by rupees and clamps with 0.01.
**Correction:** removed; the solver answers price questions and the forecast answers volume questions.

---

## C. Data, storage and alerting

**C1. Price alerts could never fire — they read a field that is never written.**
`../extenstion-v1-backup/v1/background.js :: checkPriceAlerts()` (46–63) compared `item.currentPrice <= alert.targetPrice`; watchlist items only ever stored `price`. Worst case, if the field had existed, it would have fired on a single snapshot, in a loop, for every item.
**Correction:** alerts are evaluated only inside `background.js :: recordObservation()` against a **stored** observation, only on downward crossings, de-duplicated by `lastNotifiedPricePaise`, with the notification text naming the observed price and target.
**Tests:** logic lives in `src/history.addObservation` + storage validation (tests research/storage); the worker wiring is exercised manually (checklist in README).

**C2. No validation, no de-duplication.**
v1 `SAVE_PRICE_POINT` appended blindly, kept “last 90” *points* (not days), and accepted any number.
**Correction:** `src/storage.js` validates and repairs every read (schema v2, duplicate watchlist entries dropped, invalid observations dropped, alert targets coerced from ₹ to paise); `price-history.addObservation` rejects non-positive prices and de-duplicates; `storage.evict()` trims the least-recently-observed products at the cap.
**Tests:** `tests/storage.test.js` (8 tests).

**C3. Page text was interpolated into `innerHTML`.**
v1 watchlist rows and toasts injected listing titles unescaped (`../extenstion-v1-backup/v1/content.js` line 1035 and elsewhere), so a crafted listing title could execute script inside the extension’s isolated world UI.
**Correction:** v2 `content.js` and `popup.js` never use `innerHTML`; every string is inserted via `textContent` (or `createElementNS` for the SVG sparkline).

**C4. Schema and migration.**
v1 stored flat keys (`watchlist`, `priceHistory`, `priceAlerts`, `searchHistory`) with no version. v2 has `schemaVersion: 2`, a documented migration that carries genuine price points and watchlist entries forward, explicitly drops the fabricated keys, and records what was migrated in `meta.notes`.
**Tests:** `tests/storage.test.js` tests 2–3.

**C5. Capability overclaims in UI and README.**
v1 README promised “Search Volume”, “Keyword Difficulty”, “Rank Position”, “Net Profit — Actual profit after all deductions”, “Trending Categories”, “all platforms”.
**Correction:** README capability matrix; the popup renders its table from `MARKETPLACES` data including `extractionTested: false` labels and “fee model not implemented” badges.

**C6. Dead file.**
`extractors.js` was never referenced by `manifest.json` and duplicated extraction logic.
**Correction:** deleted (available in `../extenstion-v1-backup/v1/`); extraction lives only in `src/adapters.js`.

**C7. Over-broad manifest.**
v1 exposed `web_accessible_resources` (`icons/*`, `popup.html`) to `<all_urls>` and requested the `scripting` permission it did not use.
**Correction:** `web_accessible_resources` removed, `scripting` removed; permissions are `storage`, `activeTab`, `alarms`, `notifications`. Host permissions match only the sites with adapters.

**C8. Duplicate sidebar / listener risk.**
v1 built the sidebar and its toggle button on init without a guard.
**Correction:** `window.__marketLensV2Loaded` guard plus a single fixed root id; `runtime.onMessage`/`storage.onChanged` listeners are registered once inside that guard.

---

## D. Fee-model structural gaps

| v1 | v2 (`src/fee-engine.js`, `src/platform-rules.js`) |
| --- | --- |
| Weight fee = flat ₹/kg preset | Volumetric weight `(L×W×H cm)/5000`, chargeable = max(actual, volumetric); open-ended slabs with per-kg-beyond; missing weight/dims ⇒ `missing`, never guessed |
| No price-band fees | Price-band slab rules with max-exclusive bands |
| Silent “closest” rule | Deterministic specificity (seller override cumulates, then seller > structure) with equal-score conflicts **reported**, never silently resolved |
| No effective dates | `effectiveFrom`/`effectiveTo` filtering |
| No fulfilment/zone awareness | Fulfilment- and zone-scoped rules; unknown fulfilment leaves those fees `missing` |
| No clamps | Min/max clamps applied and disclosed |
| GST on fees = flat multiplier | GST on services computed on other computed service charges (excluding itself), deferred until the base exists |
| Forward + reverse logistics treated alike | Return-contingent charges (reverse logistics, return adjustments) are **excluded** from the delivered-order settlement and reported separately; the return provision models them |
| No verification metadata | Every component carries `provenance`, `verification`, `ruleId`, `lastVerifiedAt`; freshness warns ≥90 days, stales ≥180 days |

---

## E. The ₹797 fixture and what it proves

Documented case: price ₹797, marketplace fee ₹45, taxes shown ₹11, logistics ₹164, statement says ₹576.

`797 − 45 − 11 − 164 = 577`, not 576. `src/reconciliation.js` reports the ₹1 difference:

* tolerance ₹0.50 (default) → level **mismatch**, “Your components add up to ₹1 MORE than the statement…”, with plausible causes listed (a deduction missing from the list, a duplicated line, a missing credit);
* tolerance ₹1.00 → level **rounding/warn**, difference still shown, “not hidden”.

The engine never adjusts a component to make the numbers agree. Test: `tests/reconciliation.test.js` (tests 1–2), plus the integration test in `tests/module-loading.test.js`.

---

## F. Still unverified — read before trusting anything

1. **Live extraction.** Flipkart product and search adapters were verified live on 20 Oct 2026 (title/price/rating/reviews via the page’s Product JSON-LD; current-layout MRP + discount + seller + breadcrumb + stock; search cards read from the current card markup and matched by `pid`). All other adapters (Amazon IN/US, Meesho, Myntra, Snapdeal, Nykaa, AJIO, JioMart, Tata CLiQ, IndiaMART, ShopClues, generic JSON-LD) are marked `extractionTested: false`. Selectors may break at any time; when a field cannot be read it is reported as missing and excluded from every calculation.
2. **Fee rates.** No marketplace fee rate ships with v2. Structure-only rules describe *how* a charge is computed; the money comes from the seller’s rate card.
3. **Amazon US.** Fee/profit model intentionally not implemented; extraction only.
4. **Review-based sales inference** remains a hypothesis test, not data — the estimator says so on every result.
