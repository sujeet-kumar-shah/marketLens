# MarketLens — Product Review, Market Research & Detailed Build Plan

**Prepared:** 23 October 2026  
**Product:** MarketLens 2.3 — seller research and profit tooling for Indian marketplaces  
**Planning assumption:** The shared specification describes an existing codebase with working core modules and 98 tests. This plan therefore focuses on auditing, hardening, validating, and shipping the product—not rebuilding every module from zero.

---

## 1. Executive recommendation

MarketLens has a coherent product thesis: help an Indian marketplace seller answer **“At this price, after my actual fees and costs, how much cash will settle and what contribution will the order make?”** It combines transparent fee calculations, seller-entered rate cards, evidence-backed product observations, price history, and statement reconciliation in a local-first browser extension.

The strongest parts of the existing spec are:

- **Unknown is not zero.** Missing fee rates and fields stay missing and block totals where necessary.
- **Provenance is visible.** A user can distinguish a live observation, a user-entered input, a structural assumption, and a computed value.
- **Settlement and contribution are separate.** Cash paid by a marketplace is not confused with business profitability.
- **Reconciliation exposes the difference.** It does not secretly alter fees to force a match.
- **Privacy is a product feature.** The stated design stores data locally, has no account, no telemetry, and no external server.

The biggest weakness is not the calculation engine. It is the **platform-data access risk** and a crowded competitor landscape. Flipkart’s published seller terms prohibit page scraping and automatic monitoring, and Amazon’s conditions restrict data mining and similar collection tools. The current live-page extraction and automatic background watchlist checks should therefore be treated as a launch blocker until the relevant terms, permissions, and intended use have been reviewed. See the risk section below.

**Recommended strategy:** make the reliable profit and reconciliation workflow the core product. Treat marketplace-page research as a separate, compliance-gated data source. Do not expand to more adapters merely because selectors can be written. A marketplace should be called supported only after its access method is appropriate and its extraction has been verified on current pages.

## 2. Market research: what exists and what it means

This is a directional review of public product pages and extension listings, not a complete market-size study or substitute for seller interviews. Competitor positioning and prices may change.

| Competitor | Public positioning / features observed | Implication for MarketLens |
|---|---|---|
| **Flipkart Seller Lens** | Flipkart promotes an on-page browser extension for product insights, competitor research, product discovery, and listing optimization. [Official page](https://seller.flipkart.com/seller-lens) | Do not pitch “product insights on Flipkart” as the differentiator. MarketLens needs a sharper claim focused on transparent economics and reconciliation. |
| **SellerScope Global** | Product-page research panel with modeled sales/revenue ranges, margin calculation, competition/opportunity scores, listing quality, and saved research. Its Chrome Web Store listing showed Free (5 lookups/day), Starter at ₹299/month, Pro at ₹699/month, and Team at ₹1,499/month (5 seats); the listing showed an update on 19 October 2026. [Chrome Web Store listing](https://chromewebstore.google.com/detail/sellerscope-global/kaihfgnapihidpdmpgjpnkenhfpeoamk) | There is willingness to package seller research as a paid extension, but price alone is not a moat. MarketLens can appeal to sellers who prefer transparent inputs instead of modeled sales estimates. |
| **Sellerio Insights** | On-page Amazon/Flipkart/Meesho insights, seller-owned SKU margin from entered costs and fee information, listing health, stock cover, category rank, and competitor price history. It explicitly markets “No estimates. No invented sales figures.” and is free with a Sellerio account. [Chrome Web Store listing](https://chromewebstore.google.com/detail/sellerio-insights-%E2%80%94-amazo/ppdlbnlnelocppjijpblipgolbancjeb) | “No fake numbers” alone is not a unique positioning. MarketLens must prove a more specific advantage: visible fee-component rules, freshness/provenance on each number, incomplete-result handling, and settlement-statement reconciliation. |
| **ProfitDekho / ProfitDekho Lens** | Seller tools for Meesho, Flipkart and Amazon, including uploaded payment-file P&L, SKU-level costs/returns, listing-price calculation, order/label workflow, and an on-page extension. The site listed a promotional premium plan from ₹229 for 30 days and payment-file checks from ₹29. [Website](https://profitdekho.in/) · [Chrome Web Store listing](https://chromewebstore.google.com/detail/profitdekho-lens/iabnmpllppbkkbmikmdbfeiellpfmeob) | Statement-file analysis and SKU-level true-up are already commercially relevant. MarketLens should make reconciliation highly trustworthy and easy, not merely provide another calculator. |
| **Sellerio Toolkit** | Multi-marketplace order workflow automation, including order acceptance, labels, pickup flows, and other operational tasks; the site promotes a free product. [Website](https://sellerio.in/) | Avoid turning MarketLens into an all-in-one order-automation bundle. Keep the product's purpose focused on research evidence and unit economics. |

### Positioning recommendation

Use a specific, testable promise:

> **MarketLens helps Indian marketplace sellers calculate settlement and contribution from their own verified fee rules, preserve observed product evidence, and reconcile statements—without silently filling missing data with zero.**

Avoid promising any of the following unless a reliable, permitted data source is actually implemented: actual sales, search volume, impressions, conversion, return reasons, sales rank, or marketplace-internal analytics. A result's visible position on a page is **observed page order**, not a sales rank.

### Initial customer segment

Start with small Indian marketplace sellers who:

- run a limited number of SKUs and currently use spreadsheets or manual calculations;
- need to set a selling price or evaluate a product before listing;
- are surprised by settlement deductions or do not trust generic fee calculators;
- can obtain their own fee cards, cost information, and payout/settlement reports.

Do not initially target large brands requiring teams, cloud dashboards, inventory sync, or enterprise reporting. Those bring a much larger product and support burden.

## 3. Critical risk gate: marketplace data access

**Resolve this before investing further in automated capture or public distribution.** This is a product-risk assessment, not legal advice.

- Flipkart's published terms say users must not use page-scraping, robots, spiders, or automatic methods to access, acquire, copy, or monitor platform content. [Flipkart terms](https://seller.flipkart.com/seller-blog/terms-of-use)
- Amazon's Conditions of Use restrict data mining, robots, and similar data-gathering tools. [Amazon terms page](https://relay.amazon.in/terms)
- Chrome Web Store policy says extensions must disclose data handling accurately, request only the narrowest permissions, have one understandable purpose, and publish an accurate privacy policy when handling user data. The policy FAQ says local-only storage does not remove the disclosure requirement. [Chrome Web Store policies](https://developer.chrome.com/docs/webstore/program-policies/policies/) · [User data FAQ](https://developer.chrome.com/docs/webstore/user_data)
- Flipkart documents an official seller API and a third-party application process for partners/aggregators. Approval and API scope must be confirmed; seller API access should not be assumed to grant permission to collect competitor-page data. [Flipkart API docs](https://flipkart.github.io/fk-api-platform-docs/docs/intro)

### Required decision

Before enabling automated page capture or background watchlist tabs in a public release, document one of these paths for every marketplace:

1. **Written permission / approved access:** what data is permitted, for which pages, at what frequency, and under which app or partner authorization;
2. **Official API integration:** only for the data that the API expressly provides and the relevant authorization permits;
3. **User-provided data path:** seller-uploaded reports, manually entered fee rules, manual price snapshots, and imports the user has a right to use;
4. **Feature disabled:** if none of the above supports that specific behavior, do not ship it for that marketplace.

Do not try to evade a site's restrictions by calling the collector “manual” while the extension is still automatically scraping or monitoring content. Have the actual behavior reviewed. The extension can still deliver significant value through fee configuration, pricing, contribution calculations, and statement reconciliation even if some competitor-page capture features must be limited.

## 4. Scope: what to build first

### MVP must deliver

1. **A reliable unit-economics calculator** based on the seller's own configured fee rules and item costs.
2. **Two clearly separated outputs:** cash settlement and business contribution.
3. **A fee-rate-card setup flow** with scope, source, last verification date, and stale warnings.
4. **A statement reconciliation workflow** that compares entered/imported figures with the expected settlement and explains differences without forcing a match.
5. **A source-aware observation model** for data collected through approved means or added by the user.
6. **A target-price solver** for break-even, contribution, margin, or ROI goals, with re-evaluation of the final candidate.
7. **Data portability:** validated JSON export/import and a clearly labeled delete-all action.
8. **Useful onboarding, empty states, documentation, and privacy disclosure.**

### Defer until the MVP is reliable

- More marketplaces with no live verification;
- keyword-volume claims or sales estimators without defensible data;
- AI product recommendations;
- accounts, cloud sync, collaboration, and a backend;
- broad operations features such as order handling, label printing, or inventory management;
- decorative seller-panel metric cards that can only show “—”.

### UI recommendation

The spec says the sidebar resembles Seller Lens and includes areas such as Conversion Funnel, Traffic & Keywords, Price & Sales Trend, Returns & Ratings, Settlement Calculator, and Buy Now Insights. Keep real, useful features visible, but **do not fill the primary experience with unavailable marketplace-internal metrics**. Move “not available from this data source” fields into a small capability/limitations drawer. The main entry point should be “Calculate this product” or “Reconcile a settlement,” not a grid of blank cards.

## 5. Detailed implementation roadmap

The timeline below is an indicative solo-developer sequence. Because the current spec already describes substantial implementation and 98 tests, use it as a hardening roadmap; do not rewrite working modules just to match a new architecture. External terms review may take longer than development and should be tracked separately.

### Phase 0 — Audit, customer validation, and go/no-go (2–4 focused days, excluding external review)

**Tasks**

- Run the existing test suite and save the baseline result.
- Inventory each feature as: implemented + tested, implemented but not live-verified, partially implemented, or planned only.
- Verify the actual repository tree and ensure the production extension folder contains only necessary runtime files.
- Map every adapter to its current page types, data fields, collection method, permissions, and known failure modes.
- Review the terms/data-access question marketplace by marketplace and decide which features can ship.
- Interview 5–10 real Indian sellers. Ask how they calculate prices today, how they verify deductions, which fee inputs are hard to find, how they reconcile reports, what they currently pay for, and what they would trust enough to use for real pricing decisions.
- Create 3–5 concrete tasks for a seller to test using sample data: configure a rate card, calculate a price, identify an incomplete fee, solve a target price, and reconcile a statement.

**Deliverables**

- Feature matrix with verified status;
- risk/permission decision per marketplace;
- a prioritized issue list;
- a one-sentence product promise and target user;
- anonymized interview notes and the top three customer problems.

**Exit criteria**

- No public launch path depends on an unresolved assumption about automated marketplace collection.
- The MVP is narrowed to one main workflow and no more than one initial marketplace adapter unless another is genuinely verified and permitted.

### Phase 1 — Harden the financial calculation core (about 1 week)

This is the trust foundation. A visually polished extension cannot compensate for a wrong settlement or margin figure.

**Tasks**

- Review and document formula definitions for every supported fee component: percentage-of-price, fixed fee, price bands, weight slabs, volumetric weight, clamps, and GST on service charges.
- Make fee bases explicit. For example, document whether each percentage applies to item price, discounted price, shipping, or another base.
- Use deterministic decimal/money handling. Prefer integer paise or a decimal-safe library for calculations rather than relying on binary floating-point arithmetic for money.
- Define rounding points and rounding modes at component level and total level; test cases around half-paise/rupee boundaries and fee-band thresholds.
- Separate output GST from marketplace service GST and separate cash-withheld TCS/TDS from business costs. Make the effect of input-tax credit (ITC) visible in the business-contribution model rather than burying it in a total.
- Model a missing rate as `missing`, not zero. The calculation response should include `complete`, `missingComponents`, `warnings`, and component-level results.
- Ensure the target-price solver recomputes all applicable fees for each candidate price and rechecks the selected result through the normal calculation engine.
- Add a versioned calculation model or `formulaVersion` to exported results so a historic result can be understood if formulas change later.

**Acceptance criteria**

- The same inputs always produce the same results.
- Every fee result can be explained as a formula plus its inputs and rounding rule.
- An incomplete fee card cannot display an optimistic settlement total as if complete.
- The solver never reports success for an unreachable target and verifies any returned price through the standard engine.
- The sample ₹797 reconciliation is reproduced, with the ₹1 mismatch shown and not silently repaired.

### Phase 2 — Make the fee-rate card understandable and auditable (about 3–5 days)

**Tasks**

- Build a guided setup flow: marketplace → category → fulfilment type → fee component → rate/basis → effective date → verification source.
- Support multiple overlapping rules only when precedence is deterministic and visible. Show exactly which rule won and why.
- Allow users to clone/edit a rule, deactivate a rule, and view its history instead of silently overwriting an old rate.
- Store `sourceType` (for example, seller-entered rate card), `sourceNote`, `verifiedAt`, and optionally a reference attachment or note. Do not require uploading a seller panel screenshot if it is unnecessary.
- Display current, stale, and missing states consistently: the spec proposes a warning at 90 days and stale at 180 days. Keep these thresholds configurable or clearly documented.
- Include a test mode with an example rate card, clearly labeled as sample data, so new users can explore without mistaking it for an official marketplace tariff.

**Acceptance criteria**

- A user can trace each amount to a specific fee rule.
- Overlapping rules cannot silently double-count or silently override fees.
- Updating a rate does not rewrite historical observations or previously exported calculations.
- Sample values are never presented as the marketplace's official rates.

### Phase 3 — Separate settlement from contribution and finish reconciliation (about 4–6 days)

**Tasks**

- Make the two models explicit in UI labels and documentation:
  - **Cash settlement:** expected marketplace remittance after applicable seller-funded discounts, marketplace fees and service taxes, logistics deductions, and cash withholdings such as TCS/TDS, according to the seller's configured model.
  - **Business contribution:** revenue net of applicable output GST, minus COGS, packaging, seller-paid shipping, marketplace costs treated according to ITC assumptions, advertising, return/RTO provision, and other variable costs.
- Do not call contribution “net profit.” Only estimate operating profit when monthly fixed cost and order volume are supplied. Keep income-tax estimates separate, optional, and explicitly approximate.
- Provide a row-by-row reconciliation view: statement value, calculated value, delta, tolerance status, completeness, and likely causes to investigate.
- Never adjust a component to force a reconciliation match. Preserve the entered/imported statement amount and the calculator result as separate records.
- Add input validation and explicit semantics for blank, zero, not applicable, and unknown.
- Support CSV/XLSX statement import only after real sample files and schemas are collected and tested. Start with one report format rather than promising every marketplace format.

**Acceptance criteria**

- The user can see exactly which components explain the calculated settlement.
- The tolerance threshold changes only the status label; it never changes the actual delta.
- A missing component is presented as an explanation, not hidden.
- The same statement can be re-opened later with the original user-entered figures intact.

### Phase 4 — Harden observation history and product research (about 1 week, conditional on approved collection paths)

**Tasks**

- Define an observation as a timestamped record with a source, URL or user-supplied identifier, marketplace, extractor/schema version if relevant, and per-field provenance.
- For each field store a value and status, such as `observed`, `userEntered`, `calculated`, `estimated`, or `missing`, plus its capture time and source. Do not use one confidence badge for the whole product if individual fields came from different sources.
- Preserve original observed values; corrections should create a new record or clearly mark the correction rather than silently editing history.
- Deduplicate identical observations without dropping real changes. A price change should be retained even if it occurs within six hours of a previous observation. If a six-hour rule remains, use it only to suppress identical repeated snapshots, not real changes.
- Keep “observed search position” distinct from marketplace sales rank. Store query, page/capture time, page number, DOM order, and the number of items actually read.
- Do not infer sales from review-count movement in the core UI. If retained as experimentation, label it as a hypothesis in a separate research area and never feed it into settlement or profit calculations.
- Use bounded retention for large page captures and provide a count/retention explanation. Never silently evict manually saved samples.
- Implement watchlist notifications only for genuinely stored observations and only through an approved, permitted collection mechanism. Until then, support user-triggered checks or reminders to revisit items; disable automated background tab opening where permission is unresolved.

**Acceptance criteria**

- Every displayed observation answers: what was observed, where, when, and by which method?
- Missing fields stay missing; a failed extractor does not create a zero or reuse a stale value as current.
- A search position is never labelled as sales rank.
- A price-change chart requires at least two actual observations and labels dates/units correctly.

### Phase 5 — Marketplace adapter strategy and live QA (about 1 week per marketplace, depending on complexity)

**Priority order**

1. **Flipkart:** the spec says product and search pages were verified live on 20 October 2026. Re-run the test suite and current-page smoke tests after the access/terms decision. Keep it as the only “verified” adapter until test evidence says otherwise.
2. **Amazon India:** current spec says extraction is implemented but not tested live. Do not market it as fully supported until current product/search pages have been checked and access is approved.
3. **Meesho:** same approach as Amazon India—unverified until a live test matrix and permission path exist.
4. **Myntra, Snapdeal, Nykaa, AJIO, JioMart, Tata CLiQ, IndiaMART, ShopClues:** extraction alone is not full product support. Keep them experimental/disabled until a fee model, profit path, and live QA are available, or explicitly call them “basic field capture only.”

**For each marketplace**

- Maintain fixtures for common page shapes and known missing-field cases.
- Test product pages, search/category pages, pagination, variants, seller/fulfilment differences, unavailable/out-of-stock products, changed markup, and localized price formats.
- Run live smoke tests with a dated checklist and attach pass/fail evidence to the release.
- Show the page status: supported, partially readable, unsupported, or unavailable under current access rules.
- Version adapters and keep a rollback path if a marketplace changes its page structure.
- If a selector fails, return a specific missing state and troubleshooting guidance. Do not fall back to a guessed selector value or a cached price without a stale label.

**Acceptance criteria**

- A marketplace's public support status matches its current verified test status.
- No release note claims current support based only on fake-DOM fixtures.
- A parser change must not break another marketplace adapter.

### Phase 6 — UX, onboarding, privacy, and data portability (about 4–6 days)

**First-run journey**

1. Open MarketLens and read a short explanation of the data it does and does not collect.
2. Choose the initial supported marketplace or select “calculator only.”
3. Add the minimum required fee rules or load an explicitly labeled demo rate card.
4. Enter COGS and other known costs.
5. See a calculation with complete/missing status and drill into any line item.
6. Save/export the result or reconcile it against a statement.

**Tasks**

- Use plain-language explanations for cash settlement, contribution, ITC, TCS/TDS, stale rates, and incomplete calculations.
- Use compact field-level badges: `Observed`, `Your input`, `Calculated`, `Estimate`, `Missing`, `Stale`. Do not use a single badge that implies all fields have the same source.
- Remove or collapse blank seller-only analytics cards. Put unavailable fields in a capability drawer explaining why they cannot be observed from the current data source.
- Ensure keyboard accessibility, visible focus states, readable contrast, and responsive sidebar layouts.
- Audit every permission in `manifest.json`; remove permissions that are no longer needed. Keep the extension's single purpose clearly defined as product research and unit economics.
- Publish a privacy policy even if data remains local, because local storage does not remove Chrome Web Store disclosure obligations when user/site data is handled.
- Explain what is read, what is stored, where it is stored, whether anything leaves the device, retention limits, export/import behavior, and delete-all behavior. Ensure the store listing, in-product onboarding, and actual code all agree.
- Keep `textContent` or safe DOM APIs for page-derived text; preserve the existing no-`innerHTML` pattern.
- Validate imports before merge, reject unknown schema versions safely, and test corrupt/partial backups. Make delete-all require a clear confirmation and verify that it removes all MarketLens-owned local records.

**Acceptance criteria**

- A new user can reach a valid sample calculation without confusing demo numbers for real rates.
- The UI never describes locally stored data as server-synced or vice versa.
- Users can export, restore, and delete their data reliably.
- Permissions, public description, privacy policy, and runtime behavior match.

### Phase 7 — Beta and release (1–2 weeks)

**Beta cohort**

- Recruit 10–15 sellers across different product categories and experience levels.
- Ask them to use MarketLens for real pricing decisions only after they have verified the relevant fee inputs themselves.
- Collect bug reports and usability feedback; do not collect browsing or calculation telemetry by default if the product promise is “no analytics.” Use voluntary user-submitted reports or local diagnostic exports instead.

**Test checklist**

- Fresh installation and upgrade from the previous version;
- migration from the older schema, including deliberate corruption/partial records;
- rate-card add/edit/delete and rule precedence;
- calculation completeness and money rounding;
- impossible and reachable solver targets;
- statement reconciliation at zero, below-tolerance, above-tolerance, and missing-input cases;
- export/import into a fresh profile and delete-all verification;
- marketplace page types that are approved and officially marked as supported;
- watchlist behavior when the page is unavailable, unreadable, stale, or does not cross the target;
- browser service-worker suspension/restart and extension reload;
- no duplicate sidebar, unhandled console error, runaway notification, or silent data deletion.

**Release gates**

- No open critical calculation bug;
- no unresolved page-collection permission issue for any enabled adapter;
- all advertised features work in a clean profile;
- privacy policy and Chrome Web Store disclosures are accurate;
- current manual QA checklist is complete;
- rollback/release notes and known limitations are prepared.

## 6. Technical structure to preserve and improve

Do not do a large rewrite before the audit. The spec describes small dependency-free scripts, UMD modules attached to `globalThis.MarketLens`, an MV3 background service worker, a content script, `chrome.storage.local`, and a 98-test Node test suite. That can remain viable if the boundaries are clear.

Suggested logical boundaries:

- `manifest/`: declared permissions, content scripts, matches, icons, service-worker entry point;
- `adapters/`: marketplace-specific parsing only; no profit formulas;
- `normalization/`: canonical product identity, parsed money, field-level provenance, explicit missing states;
- `domain/fees/`: fee rules, rule applicability, fee components, GST and rounding;
- `domain/profit/`: settlement, contribution, return/ad assumptions, target-price solver;
- `domain/reconciliation/`: source statement vs expected settlement and variance reasons;
- `domain/observations/`: dedupe, historical snapshots, price/rating trends, capture metadata;
- `storage/`: schema versioning, migrations, validation, import/export, cleanup and bounded retention;
- `ui/`: sidebar, popup, rate-card editor, calculator, reconciliation, watchlist, capability states;
- `tests/`: unit, property/boundary, migration, adapter fixture, and browser smoke tests.

The current file layout can differ; the key rule is to keep parsing, domain calculations, storage, and UI separate. A DOM selector change should not alter the fee engine. A fee formula change should not alter page parsing.

### Data model principles

- **Product identity:** marketplace, marketplace-specific ID if genuinely observed, canonical URL, variant identifiers when available.
- **Observation:** captured timestamp, source type, source reference, adapter version, page/capture metadata, normalized fields, and field-level provenance.
- **Fee rule:** marketplace, category, fulfilment scope, component type, formula/base, amount/rate, applicable ranges/slabs, effective date, source note, verification date, rule ID, and version.
- **Cost profile:** COGS, packaging, seller shipping, advertising, return/RTO assumption, other variable costs, fixed costs and expected volume; unknown must be different from a user-entered zero.
- **Calculation result:** inputs or an immutable input snapshot, formula version, fee component breakdown, missing components, assumptions, and outputs.
- **Reconciliation:** original statement values, calculated values, deltas, tolerance, completeness, user notes, and reconciliation timestamp.
- **Watchlist item:** product identity, target, alert rule, last successful observation, and alert history. Only permitted and genuine observations may trigger alerts.

### Storage note

The current spec says all data is stored in `chrome.storage.local`. Audit storage volume and quotas with realistic captures. If historical snapshots outgrow suitable local storage, consider using `IndexedDB` for larger structured histories while keeping small settings/rate-card preferences in extension storage. This should be an evidence-based optimization, not an early rewrite. Keep export/import capable of backing up all user-owned data whichever store is chosen.

## 7. Testing plan and quality bar

The current 98 tests are a good start, but count alone is not proof of coverage. Organize them by risk.

| Test area | Must cover |
|---|---|
| Money parsing | Indian number formats, commas, currency symbols, blank, invalid strings, negative values, rounding boundaries |
| Fee engine | each fee type, base selection, fee-slab boundaries, clamps, weight rounding, volumetric divisor, GST base, rule precedence, missing rate |
| Settlement/contribution | discount treatment, service tax, TCS/TDS cash withholding, output GST, ITC, costs, returns, fixed-cost prerequisites |
| Solver | break-even, reachable/unreachable targets, non-monotonic fee bands, exact re-evaluation of chosen price |
| Reconciliation | exact match, rounding differences, tolerance edges, missing inputs, preserving original statement values |
| Observations | genuine-change capture, identical-snapshot dedupe, failed parse, stale fields, history retention, chart minimum points |
| Adapters | fixture tests for current pages, changed DOM, no price, multiple variants, out-of-stock state, localized values |
| Storage | migration, corrupt rows, partial imports, merge collisions, duplicate IDs, schema-version mismatch, full deletion |
| Extension integration | manifest load order, suspended/restarted service worker, sidebar duplication, no unhandled exceptions, permissions limited to need |
| Release smoke | current live page matrix only for allowed/approved data paths; record date and result for each market |

Add property-based or randomized tests where practical for money arithmetic and invariants. Important invariants include: missing fee rates are never coerced to zero; increasing a positive variable cost cannot increase contribution when all other inputs remain unchanged; the solver's answer passes the main calculation engine; and reconciliation tolerance never changes the computed delta.

## 8. Pricing and go-to-market experiments

Do not set final pricing before seller interviews. Competitors in this segment range from free tools to paid plans, with public examples around ₹229–₹299/month for entry paid tiers and higher-priced research plans. The existence of free alternatives makes generic feature bundling difficult to sell; accuracy, saved time, and confidence in the numbers must be demonstrated.

Test these options with real users rather than committing immediately:

- **Free:** calculator, one fee-rate card, manual/user-provided observations, export, and basic reconciliation.
- **Pro trial:** multiple rate cards/marketplaces where appropriately supported, bulk statement workflows, advanced saved comparisons, and richer exports.
- **Paid model experiment:** compare a low monthly subscription against a one-time desktop/extension license. Validate whether users value ongoing updates and support enough for recurring payment.

Avoid charging for features that rely on unverified data or that mainly display unavailable metrics.

### Launch sequence

1. Publish a simple landing page with one clear problem statement, real screenshots, supported-platform status, a two-minute demo, privacy explanation, and a visible limitations section.
2. Recruit testers directly from seller communities and conversations; ask for task completion and accuracy feedback, not just likes.
3. Share case studies only with the seller's permission and without exposing order, buyer, or financial information.
4. Release to the Chrome Web Store only after permissions, platform-access decisions, disclosures, and all advertised features are verified.
5. Monitor voluntary support reports and extension crash/bug reports. Do not add silent telemetry that conflicts with a local-first/no-analytics promise.

## 9. Product metrics to track without betraying the privacy promise

The product can measure progress using opt-in research and local diagnostic exports rather than collecting browsing data centrally.

- **Activation:** percentage of beta users who configure a rate card and complete a first valid calculation.
- **Time to value:** time from install to first complete calculation, measured during moderated testing or explicitly opted-in study.
- **Comprehension:** whether users can explain settlement vs contribution and identify which rates are missing.
- **Task success:** percent of users who can reconcile a statement and explain the mismatch without help.
- **Trust:** how often users can identify the source of a displayed value; whether they mistake observed rank for sales rank or estimate for fact.
- **Reliability:** calculation defects, import failures, schema migration failures, and live-adapter failure rate from voluntary reports.
- **Retention/value:** users returning for another pricing or reconciliation workflow; measure through opt-in cohorts or anonymous aggregate methods only if consistent with the privacy promise and disclosed in advance.

## 10. Build order: prioritized backlog

### P0 — Launch blockers

- [ ] Document permitted access path per marketplace and disable unsupported collection paths.
- [ ] Audit all claims in the README, UI, website, and store listing against what currently works.
- [ ] Review money arithmetic, formula bases, rounding, and missing-data propagation.
- [ ] Verify settlement and contribution output semantics with sample real-world statements.
- [ ] Validate fee-rule scope and precedence and preserve rule history.
- [ ] Publish complete local-data/privacy disclosures and trim unnecessary permissions.
- [ ] Re-run all tests and add any missing P0 regression cases.

### P1 — MVP quality

- [ ] Finish a first-run fee-card setup wizard.
- [ ] Improve the reconciliation screen and explanations for common variance causes.
- [ ] Improve import/export and delete-all behavior tests.
- [ ] Keep only current, verified marketplace adapters enabled.
- [ ] Add clear field-level provenance, stale/missing statuses, and calculation completeness.
- [ ] Remove or collapse unavailable seller-only metrics from the primary UI.
- [ ] Conduct 5–10 seller interviews and a 10–15 seller beta.

### P2 — Differentiation

- [ ] Better statement import for one real format at a time.
- [ ] Historical comparison with clear timestamps and source information.
- [ ] Price solver UX with transparent assumptions and a one-click explanation of the chosen price.
- [ ] Exportable calculation/reconciliation report that a seller can save with their records.
- [ ] More marketplaces only after permitted access, live verification, and sufficient financial modeling.

### P3 — Later, only if users ask for it

- [ ] Advanced portfolio/multi-SKU analytics;
- [ ] optional encrypted backup or sync, only if the local-only product thesis changes deliberately;
- [ ] paid plans, license management, and team features;
- [ ] integrations beyond the initial marketplace and statement workflow.

## 11. Definition of done

MarketLens is ready for a public MVP when:

- A first-time seller can get a complete result with their own rates and costs without guidance.
- Every displayed number is identifiable as observed, user-entered, calculated, estimated, missing, or stale.
- Incomplete inputs never produce an apparently complete optimistic result.
- Cash settlement and business contribution are explained and calculated separately.
- Statement discrepancies remain visible and are never silently “fixed.”
- The solver validates its answer by running the normal fee/profit engine again.
- Each enabled marketplace has a documented, permitted data path and recent live-test evidence.
- Export/import/delete are reliable, and privacy claims match the actual runtime behavior.
- The Chrome Web Store listing describes one clear purpose and makes accurate, complete disclosures.
- Beta sellers can explain why they trust the result and what they would pay to avoid their current workflow.

## Final recommendation

**Do not make “more marketplaces” the next milestone.** First clear the data-access risk, validate the financial model, and make reconciliation excellent. The most defensible version of MarketLens is the tool sellers trust when a generic calculator gives one number but cannot show which rates, assumptions, and deductions produced it. A narrower trustworthy MVP is more valuable than a broad panel of unsupported or unavailable metrics.
