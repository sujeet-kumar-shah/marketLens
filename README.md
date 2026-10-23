# MarketLens 

Seller research and profit tooling for Indian marketplaces — built on one rule:
**never present an estimate as a fact, and never turn missing data into zero.**

A browser extension (Manifest V3) that:

* reads the **current listing** and shows every field with its provenance badge;
* records **genuine price observations** (only from pages you actually open or the watchlist re-check opens);
* captures the **search / category pages you open** and shows insight tiles: settlement ballpark, observed search rank, price position and rating;
* computes **marketplace charges, settlement and contribution** from *your* fee rate card through a transparent, component-based fee engine;
* lets you **reconcile a settlement statement** and shows every difference instead of hiding it;
* keeps everything **in your browser** — no account, no server, no analytics.

---

## Install (Chrome, unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the **extension folder** (`../extenstion/` — it contains only runtime files: `manifest.json`, scripts, styles, icons). This README, `tests/`, `package.json`, `AUDIT.md` and `generate_icons.js` live here in `extenstion-dev/`, one level up.
4. Pin the MarketLens icon. Open a product page on a supported marketplace; the sidebar appears. Close it with the **×** button or `Escape`, then reopen it with the floating chat-bubble button. The popup shows support status, your rate card, tax treatment, settings and data tools.

No build step. No dependencies. Node is only needed to run the test suite.

---

## The two numbers that matter (they are deliberately different)

| Metric | What it is | Where |
| --- | --- | --- |
| **Cash settlement** | What the marketplace pays into your bank for one delivered order: price − seller-funded discount − marketplace charges (including GST on services) − TCS/TDS withheld. COGS is *not* deducted. | Profit & Taxes → “Cash settlement” |
| **Business contribution** | Revenue net of output GST, minus COGS, prep, seller shipping, marketplace cost (ITC-aware), return provision and other variable costs. | Profit & Taxes → “Business view” |

Contribution is **not** called “net profit”. Operating profit only appears when you enter monthly fixed costs *and* a volume. Income-tax figures are labelled rough and ignored unless you configure a rate.

### The ₹797 worked example

A seller reports: price ₹797, marketplace fee ₹45, taxes ₹11, logistics ₹164, and a statement settlement of ₹576.

* MarketLens computes `797 − 45 − 11 − 164 = ₹577`.
* ₹577 vs ₹576 is a **₹1 difference** — flagged as a mismatch under the default ₹0.50 tolerance (or as “rounding, still shown” under a ₹1.00 tolerance), with the plausible causes listed.
* MarketLens **never adjusts a fee to force a match**. The difference is the output.

Enter it in the sidebar: Profit & Taxes → Statement reconciliation.

---

## Fee rate verification workflow

MarketLens ships **no marketplace fee numbers**. What it ships is *structure*: which charges exist, how each is computed (percentage of price, fixed, weight slab with `(L×W×H cm)/5000` volumetric chargeable weight, price bands, clamps), and how GST on services is based.

1. Open a product page → Profit & Taxes → **Your fee rate card**.
2. Add each rate from your seller panel / rate card: fee type, rate % and/or fixed ₹, weight slabs, category/fulfilment scope. The popup also lists saved rules and can delete them.
3. Each component in the results shows its provenance: “your rate (rule id)” or “structural rule — verify”, plus a freshness note (warn ≥90 days, stale ≥180 days).
4. Until a fee has a rate it is reported **missing**: the row shows “—”, its amount stays out of the totals, and the settlement is withheld rather than shown as an optimistic ₹0.

No fee rates ship with the extension. Out of the box every unresolved charge reads “missing” — that is deliberate, not a bug.

## How to add your actual values

Everything below is yours to enter. Until you do, the row stays “—”.

**1. Fee rate card (settlement + profit)**
* Sidebar → **Profit & Taxes** → **Your fee rate card**. Add commission %, fixed fees, weight slabs, price bands and the fulfilment/category scope they apply to.
* The popup lists saved rules and can delete them.
* Statement reconciliation (Profit & Taxes) takes the marketplace fee, taxes, logistics and claimed settlement from your real statement and flags every difference (the ₹797 case is the built-in example).

**2. Per-product costs (Profit & Taxes)**
* Product cost (COGS) per unit, packaging, seller-paid shipping, other variable costs, your return-rate card, advertising inputs, monthly fixed costs and expected volume.
* Blank means unknown — it is never treated as zero, and the result says which input is missing.

**3. Automatic observations**
* Open a product page: title, price, rating and review count (plus MRP where the page publishes it) are read from the live page and stored — one observation per price per 6-hour window.
* Open a search/category page: listings, their DOM positions, prices and ratings are captured; the product page then reports the **observed search position**.
* The watchlist re-check opens watched pages in background tabs and records only genuine reads.

**4. Export / import**
* Popup → **Your data**: export JSON, import a validated backup, or delete everything. Nothing leaves the browser.

---

## What is implemented, honestly

| Marketplace | Extraction | Fee model | Profit model |
| --- | --- | --- | --- |
| Flipkart India | implemented — **verified live 20 Oct 2026** (product + search pages; title/price/rating/reviews from JSON-LD, MRP + discount + seller + breadcrumb + stock read from the current layout) | structure only (you supply rates) | yes |
| Amazon India | implemented — **not tested live** | structure only | yes |
| Meesho | implemented — **not tested live** | structure only | yes |
| Myntra / Snapdeal / Nykaa / AJIO / JioMart / Tata CLiQ / IndiaMART / ShopClues | extraction implemented — **not tested live** | not implemented | no |
| Amazon US | extraction | not implemented (deliberately) | no |
| Any other store | best-effort generic (schema.org JSON-LD) | seller-defined | yes |

“Not tested live” means the adapter has not been verified against current pages. Flipkart product and search pages were verified live on 20 Oct 2026; Amazon India and Meesho are still untested. When a selector fails, the field is reported as missing and excluded from calculations — never guessed. On a Flipkart product page the sidebar reads title, price, MRP + discount, rating, reviews, seller, category, stock and specifications (weight/dimensions) *when the listing actually shows them* — impressions, sales, ranks, return reasons and fees are never on the page and stay “—” / “not found”.

Other features:

* **Focused sidebar** — six tabs: **Listing, Research, Price History, Settlement Calculator, Profit & Taxes, Watchlist**. The sidebar focuses on public-page observations, seller-entered values and calculations; unavailable private seller analytics (impressions, sales funnels, internal rank, return reasons and seller tier) are not presented as empty dashboard cards.
* **Quick open / close** — hide the sidebar with the close button or `Escape`; reopen it with the floating MarketLens chat-bubble button. Both controls have accessible labels.
* **Settlement Calculator (v2.3)** — the same shape sellers are used to: donut + rows (Listing Price → Fees and Taxes, with Marketplace Fee / Total Taxes sub-rows → Customer Logistics Fee → **Est. Net Settlement** → “calculated as per your rate card”). It computes from your rate card at any price you type; with no rates the donut and rows show “—” until the charge list is complete. The ₹797-style statement reconciliation remains in Profit & Taxes and is never silently adjusted.
* **Search-page capture** — supported search/category pages are captured locally: each result’s displayed position, plus price and rating *where readable*. Matching product pages report the position and capture time. Positions are DOM order — **not** a sales rank; internal marketplace rank, traffic, conversion and views are not observable from a public page and are never shown. Old captures roll off at 60 (newest kept).
* **Observed history** — genuine price observations are deduplicated and plotted only when there are enough points. Review-count history is similarly based on repeat visits; no values are interpolated.
* **Competitors** — one-page comparable scans with median/range/review-share statistics and a documented score (factors, weights, formula). The score is withheld when the sample is too small (<5) or prices are mostly unreadable. The scan card lives in the Research tab.
* **Keyword candidates** — mechanical phrases from the listing title, clearly labelled as candidates; no search-volume or keyword-performance values are shown.
* **Target price solver** — finds the lowest price meeting a break-even / profit / margin / ROI goal, recomputing fees at every candidate price, verified by re-evaluation. Unreachable goals are reported, not approximated.
* **Discount / returns / advertising / monthly forecast** — each re-runs the whole stack; assumptions are stated on screen.
* **Watchlist & alerts** — alerts fire only on a genuinely stored observation crossing your target downward. The scheduled re-check opens watched product pages in a background tab (max 2 per run); pages that cannot be read store nothing and raise nothing.

---

## Data & privacy

* Stored only in `chrome.storage.local` under a versioned schema (`schemaVersion: 2`).
* Every read is validated and repaired; corrupted or partial records cannot crash the UI or leak garbage into maths.
* v1 data migrates once: genuine price points and watchlist entries carry over; the v1 fabricated numbers (random sales/keywords/history) are **not** migrated and the migration says so.
* Popup → **Your data**: export JSON, import JSON (validated before merge), delete everything.
* No network calls, no telemetry, no external servers in any code path.

---

## Development

There is no build step or automated test suite in this checkout. JavaScript syntax can be checked with `node --check` on each `.js` file; then load the `extenstion/` folder unpacked in Chrome and follow the smoke-test checklist below.

* `extenstion/src/` — UMD modules (attach to `globalThis.MarketLens` in the browser, `module.exports` in Node). Loaded by `manifest.json` in dependency order before `content.js`; the service worker imports the subset it needs via `importScripts`.
* `content.js` is one guarded IIFE: single sidebar root, no `innerHTML` anywhere (page text is inserted via `textContent`), writes routed through the background worker.

To add a marketplace: add an entry to `MARKETPLACES` and `applicableFees` in `src/platform-rules.js`, write `structuralRules()` coverage if the charge structure is known, and (optionally) an adapter in `src/adapters.js`. Do not add rate values — those belong to the seller’s rate card.

---

## Manual test checklist (after loading unpacked)

1. Open a Flipkart/Amazon IN/Meesho **product page** → sidebar opens; observed fields show values or “not found”; the badge says whether the page was fully/partly read.
2. Listing → the observed-fields table shows values or “not found”; repeat visits can build a review-count history.
3. Settlement Calculator → with no rate card, the donut is replaced by “—” and every fee row shows “—”; add commission + a fixed fee in Profit & Taxes, then reopen the tab and the split computes from your rate card at the observed price.
4. Research → title phrases are labelled as candidates; the observed search position appears only after a matching search capture; comparable scans report the page sample or explain why no score is available.
5. Profit & Taxes → with no rate card: fee components show **missing** with reasons; settlement says ✕ incomplete.
6. Add commission 10% + a fixed fee → components compute; totals update; badge says “your rate”.
7. Solver → break even; type a higher target → expect “No price … reaches that goal” when genuinely impossible.
8. Reconciliation → enter the ₹797 data above; under default tolerance expect a ₹1 mismatch flag; set tolerance ₹1 → “rounding, still shown”.
9. Watchlist → save product, set a target above the current price, “Check watchlist now” → a background tab opens and closes; a notification fires only when a real observation crosses the target.
10. Research → open a **search page**, “Scan this page” → stats appear or an honest “0 listings / withheld” message; title keyword phrases are shown only as candidates.
11. Search capture → open a Flipkart search page: the header badge reads “Search page — capturing listings”; open one of those products → **Observed search position** shows “#N of M in ‘query’” (or explains no matching capture exists). Navigating between search and product pages without a full reload re-reads the page and updates the badge.
12. Price History / Listing → after ≥2 visits with different prices or review counts: axis-labelled charts draw; with fewer points the UI explains that repeat observations are needed.
13. Popup → capability table, tax settings, export/import, delete-everything with double confirm.
14. Close the sidebar with **×** or `Escape`, reopen with the floating chat-bubble button; the controls should not cover one another.
15. Reload the extension → sidebar is not duplicated; data persisted; no console errors.

---

## Known limitations

* Live extraction: Flipkart product and search pages were verified on 20 Oct 2026; Amazon India and Meesho are still untested. Marketplace DOMs change often, so a page that cannot be read reports missing fields instead of inventing values.
* Observed search positions are the order the site displayed at capture time — they vary with personalisation, page size and sponsored slots; they are not, and never claim to be, category sales ranks.
* Fee rates are yours to verify; structure rules (volumetric divisor, GST-on-services base) also carry verification status and should be confirmed against a recent rate card.
* Settlement reconciliation is arithmetic on the numbers you enter — not a substitute for the marketplace settlement report.
* The watchlist re-check uses background tabs, not API integrations; it reads only what the page renders.
* Income tax is a flat-rate approximation only.
