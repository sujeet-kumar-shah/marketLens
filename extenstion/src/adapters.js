// MarketLens core module: adapters.js
// Marketplace adapters: URL detection, product extraction and comparable-listing
// scanning. Extraction is deliberately defensive — every field is optional, a
// missing selector yields null (never 0), and the adapter reports which selectors
// failed so the sidebar can say "the page layout changed".
//
// Flipkart India was verified against live product and search pages on
// 20 Oct 2026. Amazon India/US and Meesho are NOT verified against live pages
// in this build. The capability matrix in src/platform-rules.js carries that status.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.adapters = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const money = require_ ? require_('./money.js') : globalThis.MarketLens.money;
  const model = require_ ? require_('./product-model.js') : globalThis.MarketLens.model;

  // ------------------------------------------------------------- DOM helpers
  function one(doc, selector) {
    if (!doc || !selector) return null;
    try { return doc.querySelector(selector); } catch (e) { return null; }
  }
  function all(doc, selector) {
    if (!doc || !selector) return [];
    try { return Array.prototype.slice.call(doc.querySelectorAll(selector)); } catch (e) { return []; }
  }
  function text(node) {
    if (!node) return null;
    const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return t || null;
  }
  function attr(node, name) {
    if (!node || !node.getAttribute) return null;
    const v = node.getAttribute(name);
    return v === null || v === undefined || v === '' ? null : v;
  }

  /** First selector that yields non-empty text. */
  function pickText(doc, selectors) {
    for (const sel of selectors) {
      const value = text(one(doc, sel));
      if (value) return { value, selector: sel };
    }
    return { value: null, selector: null };
  }
  function pickAttr(doc, selectors, name) {
    for (const sel of selectors) {
      const value = attr(one(doc, sel), name);
      if (value) return { value, selector: sel + '[' + name + ']' };
    }
    return { value: null, selector: null };
  }
  function pickPaise(doc, selectors) {
    for (const sel of selectors) {
      const raw = text(one(doc, sel)) || attr(one(doc, sel), 'content');
      const paise = money.toPaise(raw);
      if (paise !== null) return { value: paise, selector: sel, raw };
    }
    return { value: null, selector: null, raw: null };
  }
  function pickNumber(doc, selectors, pattern) {
    for (const sel of selectors) {
      const node = one(doc, sel);
      const raw = text(node) || attr(node, 'content') || attr(node, 'aria-label');
      if (!raw) continue;
      const m = pattern ? raw.match(pattern) : null;
      const candidate = m ? m[1] : raw.replace(/[^0-9.]/g, '');
      const n = parseFloat(String(candidate).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n)) return { value: n, selector: sel, raw };
    }
    return { value: null, selector: null, raw: null };
  }

  // --------------------------------------------------------------- JSON-LD
  /** Read the first schema.org Product block; a genuine structured source. */
  function readJsonLd(doc) {
    const scripts = all(doc, 'script[type="application/ld+json"]');
    for (const s of scripts) {
      const raw = s.textContent;
      if (!raw) continue;
      let data;
      try { data = JSON.parse(raw); } catch (e) { continue; }
      const list = Array.isArray(data) ? data : (data['@graph'] && Array.isArray(data['@graph']) ? data['@graph'] : [data]);
      for (const node of list) {
        if (!node || typeof node !== 'object') continue;
        const type = node['@type'];
        const isProduct = type === 'Product' || (Array.isArray(type) && type.indexOf('Product') > -1);
        if (isProduct) return node;
      }
    }
    return null;
  }

  function fromJsonLd(node) {
    if (!node) return {};
    const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    const rating = node.aggregateRating || {};
    const brandNode = node.brand;
    return {
      title: node.name || null,
      brand: typeof brandNode === 'string' ? brandNode : (brandNode && brandNode.name) || null,
      pricePaise: offers ? money.toPaise(offers.price || offers.lowPrice) : null,
      currency: (offers && offers.priceCurrency) || null,
      rating: rating.ratingValue !== undefined ? parseFloat(rating.ratingValue) : null,
      reviewCount: rating.reviewCount !== undefined ? parseInt(rating.reviewCount, 10)
        : (rating.ratingCount !== undefined ? parseInt(rating.ratingCount, 10) : null),
      productId: node.sku || node.productID || node.mpn || null,
      image: Array.isArray(node.image) ? node.image[0] : node.image || null,
      stockStatus: offers && String(offers.availability || '').indexOf('InStock') > -1 ? 'in_stock' : null
    };
  }

  // ------------------------------------------------------- text mini-parsers
  function parseWeightG(raw) {
    if (!raw) return null;
    const m = String(raw).match(/([\d.]+)\s*(kg|kilogram|g|gram|grams|gm)\b/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    return /kg|kilo/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n);
  }
  function parseDimsCm(raw) {
    if (!raw) return null;
    const m = String(raw).match(/([\d.]+)\s*[x×]\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*(cm|mm|in|inch)?/i);
    if (!m) return null;
    let unit = (m[4] || 'cm').toLowerCase();
    let f = 1;
    if (unit === 'mm') f = 0.1;
    if (unit === 'in' || unit === 'inch') f = 2.54;
    return {
      l: Math.round(parseFloat(m[1]) * f * 10) / 10,
      w: Math.round(parseFloat(m[2]) * f * 10) / 10,
      h: Math.round(parseFloat(m[3]) * f * 10) / 10
    };
  }

  function detailsText(doc, selectors) {
    const parts = [];
    for (const sel of selectors) {
      const t = text(one(doc, sel));
      if (t) parts.push(t);
    }
    return parts.join(' | ') || null;
  }

  // ------------------------------------------------------------------ util
  function categoriesFromBreadcrumb(doc, selectors) {
    const links = [];
    for (const sel of selectors) {
      const nodes = all(doc, sel);
      for (const n of nodes) {
        const t = text(n);
        if (t) links.push(t);
      }
      if (links.length) break;
    }
    if (!links.length) return { category: null, breadcrumb: [] };
    return { category: links[links.length - 1], breadcrumb: links };
  }

  // --------------------------------------------- Flipkart current front end
  // The 2026 Flipkart product page renders the main offer as a single text
  // run — discount %, MRP (no ₹), selling price — e.g. "76%1,399₹337".
  // Ad/recommendation cards use the same shape, so the Product JSON-LD price
  // identifies which block belongs to this product. No match, no guess.

  /** @returns {{value: null|{pricePaise:number,mrpPaise:number,discountPct:number},selector:string|null}} */
  function flipkartPriceBlock(doc, pricePaise) {
    const re = /^(\d{1,3})\s*%\s*(?:off)?\s*(?:₹\s*)?([\d,.]+)\s*₹\s*([\d,.]+)$/i;
    const wanted = (pricePaise === null || pricePaise === undefined) ? null : pricePaise;
    let match = null;
    let fallback = null;
    for (const node of all(doc, 'a, div')) {
      const t = text(node);
      if (!t || t.length > 60) continue;
      const m = re.exec(t);
      if (!m) continue;
      const entry = {
        pricePaise: Math.round(parseFloat(m[3].replace(/,/g, '')) * 100),
        mrpPaise: Math.round(parseFloat(m[2].replace(/,/g, '')) * 100),
        discountPct: parseInt(m[1], 10)
      };
      if (!Number.isFinite(entry.pricePaise) || !Number.isFinite(entry.mrpPaise)) continue;
      if (entry.mrpPaise <= entry.pricePaise) continue;
      if (!fallback) fallback = entry;
      if (wanted !== null && Math.abs(entry.pricePaise - wanted) <= 100) { match = entry; break; }
    }
    if (match) return { value: match, selector: 'price-block:text' };
    if (fallback && wanted === null) return { value: fallback, selector: 'price-block:text' };
    return { value: null, selector: null };
  }

  /**
   * "Seller: NAME" appears in the buy box and in the "See other sellers"
   * flyout; the buy-box copy sits next to delivery text, so it wins.
   */
  function flipkartSellerScan(doc) {
    let fallback = null;
    for (const node of all(doc, 'div')) {
      const t = text(node);
      if (!t || t.length > 300) continue;
      const m = /Seller:\s*([A-Za-z][A-Za-z0-9&._\- ]*?)(?=See other sellers|•|\d|$)/.exec(t);
      if (!m) continue;
      const name = m[1].trim();
      if (!name) continue;
      if (/delivery/i.test(t)) return { value: name, selector: 'buy-box:text' };
      if (!fallback) fallback = { value: name, selector: 'seller-list:text' };
    }
    return fallback;
  }

  /** Breadcrumb anchors (".../pr?sid="); brand nodes ("~brand") make poor categories. */
  function flipkartBreadcrumb(doc, legacySelectors) {
    const anchors = all(doc, 'a[href*="pr?sid="]');
    if (anchors.length) {
      const breadcrumb = [];
      let category = null;
      for (const a of anchors) {
        const t = text(a);
        if (!t) continue;
        breadcrumb.push(t);
        const href = attr(a, 'href') || '';
        if (href.indexOf('~brand') === -1) category = t;
      }
      if (breadcrumb.length) {
        return { category: category || breadcrumb[breadcrumb.length - 1], breadcrumb };
      }
    }
    return categoriesFromBreadcrumb(doc, legacySelectors);
  }

  // Specification rows ("labelvalue") in the 2026 layout. Only rows whose
  // label is exactly a weight/dimensions field are used — component specs
  // like "Tape Dispenser Weight" must never masquerade as the product weight.
  const FLIPKART_WEIGHT_SPEC = /^(?:net\s+|product\s+|item\s+|packed\s+|package\s+)?weight\s*[:\-–]?\s*([\d.,]+\s*(?:kg|kilos?|kilograms?|grams?|gms?|g)\b.*)$/i;
  const FLIPKART_DIMS_SPEC = /^(?:(?:product|packed|package|item)\s+)?dimensions?\s*[:\-–]?\s*([\d.]+\s*[x×]\s*[\d.]+\s*[x×]\s*[\d.]+(?:\s*(?:cm|mm|inch(?:es)?|in))?)\s*$/i;

  function flipkartSpecMatch(doc, re) {
    for (const node of all(doc, 'div')) {
      const t = text(node);
      if (!t || t.length > 90) continue;
      const m = re.exec(t);
      if (m) return { value: m[1].trim(), raw: t };
    }
    return { value: null, raw: null };
  }

  function val(field) {
    if (!field) return null;
    const v = field.value;
    return v === undefined ? null : v;
  }

  function buildResult(adapterId, currency, country, url, fields) {
    const raw = {
      marketplace: adapterId, country, currency, url,
      title: val(fields.title),
      brand: val(fields.brand),
      category: val(fields.category),
      productId: val(fields.productId),
      variantKey: val(fields.variantKey),
      pricePaise: val(fields.pricePaise),
      mrpPaise: val(fields.mrpPaise),
      rating: val(fields.rating),
      reviewCount: val(fields.reviewCount),
      sellerName: val(fields.sellerName),
      fulfilment: val(fields.fulfilment),
      actualWeightG: val(fields.actualWeightG),
      packedWeightG: val(fields.packedWeightG),
      packedDimsCm: val(fields.packedDimsCm),
      stockStatus: val(fields.stockStatus),
      attributes: val(fields.attributes),
      image: val(fields.image),
      observationTs: Date.now()
    };

    const keyFields = ['title', 'pricePaise'];
    const found = keyFields.filter(k => raw[k] !== null && raw[k] !== undefined).length;
    const extractionStatus = found === 2 ? 'ok' : found === 1 ? 'partial' : 'dom_changed';
    raw.extractionStatus = extractionStatus;

    const provenance = {};
    for (const k of Object.keys(fields)) {
      const f = fields[k];
      if (!f) continue;
      provenance[k] = f.value === null || f.value === undefined
        ? { value: null, status: 'missing', source: 'listing extraction', sourceUrl: url, observedAt: null, note: 'Selector not found (page layout may have changed)' }
        : { value: f.value, status: 'observed', source: 'listing:' + (f.selector || 'structure'), sourceUrl: url, observedAt: raw.observationTs, note: f.note || null };
    }

    const product = model.createProduct(raw, provenance);

    return {
      product,
      image: raw.image,
      extractionStatus,
      warnings: buildWarnings(raw),
      missingSelectors: Object.keys(fields).filter(k => !fields[k] || fields[k].value === null)
    };
  }

  function buildWarnings(raw) {
    const w = [];
    if (raw.pricePaise === null) w.push('Selling price could not be read — the page layout may have changed, or the price is behind a variant selection.');
    if (raw.title === null) w.push('Product title could not be read.');
    if (raw.mrpPaise === null) w.push('MRP not found — discount cannot be verified.');
    if (raw.reviewCount === null) w.push('Review count not found (it may require expanding the reviews section).');
    if (raw.actualWeightG === null) w.push('Product weight not found on the listing — needed for weight-based shipping rules.');
    if (raw.packedDimsCm === null) w.push('Packed dimensions not found — volumetric weight cannot be computed.');
    if (raw.stockStatus === null) w.push('Stock status could not be determined reliably.');
    return w;
  }

  const AMAZON_SELECTORS = {
    title: ['#productTitle', '#title', 'h1[data-feature-name="title"]'],
    price: ['#corePriceDisplay_desktop_feature_div .a-price .a-offscreen', '#corePrice_feature_div .a-offscreen',
      'span.a-price[data-a-color="base"] .a-offscreen', '.a-price .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice'],
    mrp: ['span.a-price.a-text-price[data-a-strike="true"] .a-offscreen', '#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen', '#listPrice'],
    rating: ['#acrPopover .a-icon-alt', '#acrPopover', '[data-hook="rating-out-of-text"]'],
    reviewCount: ['#acrCustomerReviewText'],
    brand: ['#bylineInfo', '.po-brand .po-break-word', 'tr.po-brand td.a-span9 span'],
    seller: ['#sellerProfileTriggerId', '#merchant-info a', '#tabular-buybox .tabular-buybox-text a'],
    fulfil: ['#fulfillerInfoFeature_feature_div .tabular-buybox-text', '#merchant-info', '#fulfillerInfoFeature_feature_div'],
    availability: ['#availability', '#outOfStock', '#availability_feature_div'],
    details: ['#detailBulletsWrapper_feature_div', '#productDetails_detailBullets_sections1', '#productDetails_feature_div', '#feature-bullets']
  };

  function amazonProductId(doc, url) {
    const fromUrl = /\/dp\/([A-Z0-9]{10})/.exec(url) || /\/gp\/product\/([A-Z0-9]{10})/.exec(url) || /\/ASIN\/([A-Z0-9]{10})/.exec(url);
    if (fromUrl) return { value: fromUrl[1], selector: 'url:/dp/' };
    const input = pickAttr(doc, ['input#ASIN', 'input[name="ASIN"]'], 'value');
    if (input.value) return { value: input.value, selector: input.selector };
    const scoped = pickAttr(doc, ['[data-feature-name="averageCustomerReviews"] [data-asin]', '#averageCustomerReviews'], 'data-asin');
    if (scoped.value) return { value: scoped.value, selector: scoped.selector };
    return { value: null, selector: null };
  }

  function amazonFulfilment(doc) {
    const f = pickText(doc, AMAZON_SELECTORS.fulfil);
    if (!f.value) return { value: null, selector: null };
    const t = f.value.toLowerCase();
    if (t.indexOf('fulfilled by amazon') > -1 || t.indexOf('amazon.in') > -1 && t.indexOf('sold by') === -1 && t.indexOf('dispatched') > -1) {
      return { value: 'fba', selector: f.selector, note: 'Detected from listing text' };
    }
    if (t.indexOf('sold by') > -1 || t.indexOf('merchant') > -1) {
      return { value: 'self', selector: f.selector, note: 'Seller-fulfilled signal on listing — confirm in your seller panel' };
    }
    return { value: null, selector: null };
  }

  function amazonStock(doc) {
    const t = (pickText(doc, AMAZON_SELECTORS.availability).value || '').toLowerCase();
    if (!t) return { value: null, selector: null };
    if (t.indexOf('in stock') > -1 || t.indexOf('available') > -1) return { value: 'in_stock', selector: 'availability' };
    if (t.indexOf('unavailable') > -1 || t.indexOf('out of stock') > -1 || t.indexOf('currently unavailable') > -1) return { value: 'out_of_stock', selector: 'availability' };
    return { value: null, selector: null };
  }

  function makeAmazonAdapter(id, country, currency) {
    return {
      id, label: id === 'amazon_in' ? 'Amazon India' : 'Amazon US', country, currency,
      match: url => id === 'amazon_in' ? /amazon\.in/.test(url) : /amazon\.com/.test(url),
      isProductPage: url => /\/(dp|gp\/product)\//.test(url),
      isSearchPage: url => /\/s\?|\/s\/|\/s$/.test(url),
      extractProduct(doc, url) {
        const ld = fromJsonLd(readJsonLd(doc));
        const title = pickText(doc, AMAZON_SELECTORS.title);
        const price = pickPaise(doc, AMAZON_SELECTORS.price);
        const mrp = pickPaise(doc, AMAZON_SELECTORS.mrp);
        const rating = pickNumber(doc, AMAZON_SELECTORS.rating, /([\d.]+)\s*out of/i);
        const reviews = pickNumber(doc, AMAZON_SELECTORS.reviewCount, /([\d,]+)/);
        const brand = pickText(doc, AMAZON_SELECTORS.brand);
        const seller = pickText(doc, AMAZON_SELECTORS.seller);
        const det = detailsText(doc, AMAZON_SELECTORS.details);
        const crumb = categoriesFromBreadcrumb(doc, ['#wayfinding-breadcrumbs_feature_div a', '#wayfinding-breadcrumbs_container a']);

        const fields = {
          title: title.value ? title : { value: ld.title, selector: 'json-ld' },
          pricePaise: price.value !== null ? price : { value: ld.pricePaise, selector: 'json-ld' },
          mrpPaise: mrp.value !== null ? mrp : { value: null, selector: null },
          rating: rating.value !== null ? rating : { value: ld.rating, selector: 'json-ld' },
          reviewCount: reviews.value !== null ? { value: Math.round(reviews.value), selector: reviews.selector } : { value: ld.reviewCount, selector: 'json-ld' },
          brand: brand.value ? brand : { value: ld.brand, selector: 'json-ld' },
          productId: amazonProductId(doc, url),
          sellerName: seller,
          fulfilment: amazonFulfilment(doc),
          category: crumb.category ? { value: crumb.category, selector: 'breadcrumb' } : { value: null, selector: null },
          actualWeightG: { value: parseWeightG(det), selector: 'details:text' },
          packedDimsCm: { value: parseDimsCm(det), selector: 'details:text' },
          stockStatus: amazonStock(doc),
          image: { value: pickAttr(doc, ['#landingImage'], 'src').value || ld.image, selector: '#landingImage' }
        };
        return buildResult(id, currency, country, url, fields);
      },
      extractComparables(doc) {
        const out = [];
        for (const el of all(doc, 'div[data-asin]')) {
          const asin = attr(el, 'data-asin');
          if (!asin || asin.length < 5) continue;
          const t = text(one(el, 'h2 span')) || text(one(el, 'h2 a span')) || text(one(el, '.a-size-medium.a-color-base.a-text-normal'));
          const p = money.toPaise(text(one(el, '.a-price .a-offscreen')) || text(one(el, '.a-price-whole')));
          if (!t || p === null) continue;
          const rating = text(one(el, 'span.a-icon-alt'));
          const reviewsNode = one(el, 'span[aria-label$="ratings"]') || one(el, '.s-underline-text');
          const reviewsRaw = text(reviewsNode) || attr(reviewsNode, 'aria-label');
          out.push({
            productId: asin,
            title: t,
            pricePaise: p,
            rating: rating ? parseFloat(rating) : null,
            reviewCount: reviewsRaw ? parseInt(reviewsRaw.replace(/[^0-9]/g, ''), 10) : null,
            sponsored: !!one(el, '.puis-sponsored-label-text, .s-sponsored-label'),
            brand: text(one(el, 'h5 span, .a-size-base-plus.a-color-base')),
            url: null
          });
        }
        return out;
      }
    };
  }

  function makeFlipkartAdapter() {
    const S = {
      title: ['span.VU-ZEz', 'span.B_NuCI', 'h1.yhB1nd', 'h1 span', 'div._35KyD6', 'h1'],
      price: ['div.Nx9bqj.CxhGGd', 'div.Nx9bqj', 'div._30jeq3._16Jk6d', 'div._30jeq3'],
      mrp: ['div.yRaY8j', 'div._3I9_wc._2p6lqe', 'div._3I9_wc'],
      discount: ['div.UkUFwK span', 'div.UkUFwK', 'div._3Ay6Sb span', 'div._3Ay6Sb', 'span._1V_ZGU'],
      rating: ['div.XQDdHH', 'div._3LWZlK', 'div.gYytql'],
      reviewCount: ['span.Wphh3N', 'span._2_R_DZ', 'div._13vcmD', 'span._13vcmD'],
      seller: ['#sellerName span', '#sellerName a', 'div._3nfOpW a', 'div._3nfOpW'],
      breadcrumb: ['div._1MR4o5 a', 'a._2whKao', 'div.RG5Slk a'],
      stock: ['div._16FRp0', 'div.Z8JjpR', 'div._3xg8l9'],
      details: ['div._1s8lJC', 'div._3k-BhJ', 'table._14cfVK', 'div.X3BRps']
    };
    return {
      id: 'flipkart', label: 'Flipkart India', country: 'IN', currency: 'INR',
      match: url => /flipkart\.com/.test(url),
      isProductPage: url => /\/p\//.test(url) || /[?&]pid=/.test(url),
      isSearchPage: url => /\/search\b/.test(url) || /[?&]q=/.test(url),
      extractProduct(doc, url) {
        const ld = fromJsonLd(readJsonLd(doc));
        const title = pickText(doc, S.title);
        const price = pickPaise(doc, S.price);
        const mrp = pickPaise(doc, S.mrp);
        const rating = pickNumber(doc, S.rating, /([\d.]+)/);
        const reviews = pickNumber(doc, S.reviewCount, /([\d,]+)/);
        const seller = pickText(doc, S.seller);
        const sellerScan = flipkartSellerScan(doc);
        const crumb = flipkartBreadcrumb(doc, S.breadcrumb);
        const det = detailsText(doc, S.details);
        const fsn = /[?&]pid=([A-Za-z0-9]+)/.exec(url);
        const stock = pickText(doc, S.stock);
        const block = flipkartPriceBlock(doc, ld.pricePaise === undefined ? null : ld.pricePaise);
        const specWeight = flipkartSpecMatch(doc, FLIPKART_WEIGHT_SPEC);
        const specDims = flipkartSpecMatch(doc, FLIPKART_DIMS_SPEC);
        const weightFromSpec = parseWeightG(specWeight.value);
        const weightG = weightFromSpec !== null ? weightFromSpec : parseWeightG(det);
        const dims = parseDimsCm(specDims.value) || parseDimsCm(det);

        let stockStatus = null;
        if (stock.value) {
          const t = stock.value.toLowerCase();
          if (t.indexOf('sold out') > -1 || t.indexOf('coming soon') > -1) stockStatus = 'out_of_stock';
          else if (t.indexOf('in stock') > -1) stockStatus = 'in_stock';
        }
        if (stockStatus === null && ld.stockStatus) stockStatus = ld.stockStatus;

        const priceField = (ld.pricePaise === null || ld.pricePaise === undefined)
          ? (price.value !== null ? price : (block.value ? { value: block.value.pricePaise, selector: block.selector } : price))
          : { value: ld.pricePaise, selector: 'json-ld' };

        const fields = {
          // The current Flipkart front end ships hashed class names that change
          // between builds; its Product JSON-LD is stable and carries the same
          // visible price, so structured data wins and selectors are the fallback.
          title: ld.title ? { value: ld.title, selector: 'json-ld' } : title,
          pricePaise: priceField,
          mrpPaise: mrp.value !== null ? mrp : (block.value ? { value: block.value.mrpPaise, selector: block.selector } : mrp),
          rating: rating.value !== null ? rating : { value: ld.rating, selector: 'json-ld' },
          reviewCount: reviews.value !== null ? { value: Math.round(reviews.value), selector: reviews.selector } : { value: ld.reviewCount, selector: 'json-ld' },
          brand: { value: ld.brand || crumb.breadcrumb[0] || null, selector: ld.brand ? 'json-ld' : (crumb.breadcrumb.length ? 'breadcrumb' : null) },
          productId: { value: fsn ? fsn[1] : (ld.productId || null), selector: fsn ? 'url:pid' : 'json-ld' },
          sellerName: sellerScan || seller,
          fulfilment: { value: null, selector: null, note: 'Flipkart listings rarely state the fulfilment arrangement — set it in Profit & Settlement.' },
          category: { value: crumb.category, selector: crumb.breadcrumb.length ? 'breadcrumb' : null },
          actualWeightG: { value: weightG, selector: weightFromSpec !== null ? 'specs:text' : (det ? 'details:text' : null) },
          packedDimsCm: { value: dims, selector: specDims.value ? 'specs:text' : (det ? 'details:text' : null) },
          stockStatus: { value: stockStatus, selector: stockStatus === null ? null : (stock.selector || 'json-ld') },
          image: { value: attr(one(doc, 'img._396cs4, img._2r_T1I, img.DByuf4'), 'src') || ld.image, selector: 'img' }
        };
        return buildResult('flipkart', 'INR', 'IN', url, fields);
      },
      extractComparables(doc) {
        const out = [];
        for (const el of all(doc, 'div[data-id]')) {
          const t = text(one(el, 'div.KzDlHZ')) || text(one(el, 'div._4rR01T')) || text(one(el, 'a[title]'));
          const p = money.toPaise(text(one(el, 'div.hZ3P6w')) || text(one(el, 'div.Nx9bqj')) || text(one(el, 'div._30jeq3')));
          if (!t || p === null) continue;
          const rating = text(one(el, 'div.XQDdHH')) || text(one(el, 'div._3LWZlK'));
          const reviews = text(one(el, 'span.Wphh3N')) || text(one(el, 'span._2_R_DZ'));
          out.push({
            productId: attr(el, 'data-id'),
            title: t,
            pricePaise: p,
            rating: rating ? parseFloat(rating) : null,
            reviewCount: reviews ? parseInt(reviews.replace(/[^0-9]/g, ''), 10) : null,
            sponsored: !!one(el, 'span._2w9YJt, div._3n8fna'),
            brand: null,
            url: null
          });
        }
        return out;
      }
    };
  }

  function makeMeeshoAdapter() {
    return {
      id: 'meesho', label: 'Meesho', country: 'IN', currency: 'INR',
      match: url => /meesho\.com/.test(url),
      isProductPage: url => /\/p\//.test(url) || /\/product\//.test(url),
      isSearchPage: url => /\/search/.test(url),
      extractProduct(doc, url) {
        const ld = fromJsonLd(readJsonLd(doc));
        const title = pickText(doc, ['h1', 'span[class*="ProductTitle"]', 'p[class*="ProductTitle"]']);
        const price = pickPaise(doc, ['meta[property="product:price:amount"]', 'h4[class*="Price"]', 'h4', 'span[class*="Price"]']);
        const mrp = pickPaise(doc, ['del', 'span[class*="Strike"]', 'p[class*="Strike"]', 'h5[class*="Strike"]']);
        const rating = pickNumber(doc, ['span[class*="Rating"]', 'div[class*="Rating"]'], /([\d.]+)/);
        const reviews = pickNumber(doc, ['span[class*="Reviews"]', 'span[class*="review"]', 'div[class*="Review"]'], /([\d,]+)/);
        const seller = pickText(doc, ['p[class*="Supplier"]', 'span[class*="Supplier"]', 'div[class*="seller"]']);
        const idMatch = /\/p\/?([A-Za-z0-9-]+)/.exec(url) || /\/([A-Za-z0-9]{6,})\/?$/.exec(url);

        const fields = {
          title: title.value ? title : { value: ld.title, selector: 'json-ld' },
          pricePaise: price.value !== null ? price : { value: ld.pricePaise, selector: 'json-ld' },
          mrpPaise: mrp,
          rating: rating.value !== null ? rating : { value: ld.rating, selector: 'json-ld' },
          reviewCount: reviews.value !== null ? { value: Math.round(reviews.value), selector: reviews.selector } : { value: ld.reviewCount, selector: 'json-ld' },
          brand: { value: ld.brand, selector: 'json-ld' },
          productId: { value: idMatch ? idMatch[1] : ld.productId, selector: 'url' },
          sellerName: seller,
          fulfilment: { value: null, selector: null, note: 'Meesho fulfilment is arranged by Meesho — confirm the arrangement for your account.' },
          category: categoriesFromBreadcrumb(doc, ['div[class*="Breadcrumb"] a', 'a[href*="/category"]']).category
            ? { value: categoriesFromBreadcrumb(doc, ['div[class*="Breadcrumb"] a', 'a[href*="/category"]']).category, selector: 'breadcrumb' }
            : { value: null, selector: null },
          actualWeightG: { value: parseWeightG(detailsText(doc, ['div[class*="ProductDetails"]', 'div[class*="specification"]'])), selector: 'spec text' },
          packedDimsCm: { value: parseDimsCm(detailsText(doc, ['div[class*="ProductDetails"]', 'div[class*="specification"]'])), selector: 'spec text' },
          stockStatus: { value: pickText(doc, ['div[class*="OutOfStock"]']).value ? 'out_of_stock' : null, selector: 'out-of-stock marker' },
          image: { value: attr(one(doc, 'img[class*="Product"], img[class*="product"]'), 'src') || ld.image, selector: 'img' }
        };
        return buildResult('meesho', 'INR', 'IN', url, fields);
      },
      extractComparables() { return []; }
    };
  }

  function makeSimpleAdapter(id, label, domains, opts) {
    const o = opts || {};
    return {
      id, label, country: 'IN', currency: 'INR',
      match: url => domains.some(d => url.indexOf(d) > -1),
      isProductPage: url => (o.productPattern || /./).test(url),
      isSearchPage: url => (o.searchPattern || /$^/).test(url),
      extractProduct(doc, url) {
        const ld = fromJsonLd(readJsonLd(doc));
        const title = pickText(doc, o.title || ['h1']);
        const price = pickPaise(doc, (o.price || []).concat(['meta[property="product:price:amount"]', '[itemprop="price"]']));
        const mrp = pickPaise(doc, o.mrp || ['del', 's', 'span[class*="mrp"]']);
        const rating = pickNumber(doc, (o.rating || []).concat(['[itemprop="ratingValue"]']), /([\d.]+)/);
        const reviews = pickNumber(doc, (o.reviews || []).concat(['[itemprop="reviewCount"]']), /([\d,]+)/);
        const brand = pickText(doc, (o.brand || []).concat(['[itemprop="brand"]']));
        const fields = {
          title: title.value ? title : { value: ld.title, selector: 'json-ld' },
          pricePaise: price.value !== null ? price : { value: ld.pricePaise, selector: 'json-ld' },
          mrpPaise: mrp,
          rating: rating.value !== null ? rating : { value: ld.rating, selector: 'json-ld' },
          reviewCount: reviews.value !== null ? { value: Math.round(reviews.value), selector: reviews.selector } : { value: ld.reviewCount, selector: 'json-ld' },
          brand: brand.value ? brand : { value: ld.brand, selector: 'json-ld' },
          productId: { value: (function () {
            const m = /\/(\d{5,})(?:[/?]|$)/.exec(url) || /[?&](?:id|productId|pid)=([A-Za-z0-9-]+)/.exec(url);
            return m ? m[1] : (ld.productId || model.hashKey(url));
          })(), selector: 'url' },
          sellerName: pickText(doc, o.seller || ['[class*="seller"]']),
          fulfilment: { value: null, selector: null },
          category: { value: null, selector: null },
          actualWeightG: { value: parseWeightG(detailsText(doc, o.details || [])), selector: 'details' },
          packedDimsCm: { value: parseDimsCm(detailsText(doc, o.details || [])), selector: 'details' },
          stockStatus: { value: null, selector: null },
          image: { value: attr(one(doc, 'meta[property="og:image"]'), 'content') || ld.image, selector: 'og:image' }
        };
        return buildResult(id, 'INR', 'IN', url, fields);
      },
      extractComparables() { return []; }
    };
  }

  const ADAPTERS = [
    makeAmazonAdapter('amazon_in', 'IN', 'INR'),
    makeAmazonAdapter('amazon_us', 'US', 'USD'),
    makeFlipkartAdapter(),
    makeMeeshoAdapter(),
    makeSimpleAdapter('myntra', 'Myntra', ['myntra.com'], {
      productPattern: /\/buy/,
      title: ['h1.pdp-title', '.pdp-name'],
      price: ['.pdp-price strong', '.pdp-price'],
      mrp: ['.pdp-mrp s'],
      rating: ['.index-overallRating'],
      reviews: ['.index-ratingsCount']
    }),
    makeSimpleAdapter('snapdeal', 'Snapdeal', ['snapdeal.com'], {
      productPattern: /\/product\//, title: ['h1.pdp-e-i-head'], price: ['.payBlkBig'], mrp: ['.product-desc-price'], rating: ['.filled-stars'], reviews: ['.reviewCount']
    }),
    makeSimpleAdapter('nykaa', 'Nykaa', ['nykaa.com'], {
      productPattern: /\/p\//, title: ['h1'], price: ['[class*="price"]'], mrp: ['[class*="mrp"]']
    }),
    makeSimpleAdapter('ajio', 'AJIO', ['ajio.com'], { productPattern: /\/p\//, title: ['h1'], price: ['.prod-sp'], mrp: ['.prod-cp'] }),
    makeSimpleAdapter('jiomart', 'JioMart', ['jiomart.com'], { productPattern: /\/p\//, title: ['h1'], price: ['.jm-heading-xxs'], mrp: ['.jm-body-xxs'] }),
    makeSimpleAdapter('tatacliq', 'Tata CLiQ', ['tatacliq.com'], { productPattern: /\/p\//, title: ['h1'], price: ['[class*="price"]'] }),
    makeSimpleAdapter('indiamart', 'IndiaMART', ['indiamart.com'], { productPattern: /\/proddetail\//, title: ['h1'], price: ['[class*="price"]'] }),
    makeSimpleAdapter('shopclues', 'ShopClues', ['shopclues.com'], { productPattern: /\/product\//, title: ['h1'], price: ['[class*="price"]'] })
  ];

  function adapterFor(url) {
    for (const a of ADAPTERS) {
      try { if (a.match(url)) return a; } catch (e) { /* keep looking */ }
    }
    return null;
  }

  /** Generic fallback: structured data first, then conservative heuristics. */
  const GENERIC = {
    id: 'generic', label: 'Generic store', country: 'IN', currency: 'INR',
    match: () => true,
    isProductPage: url => true,
    isSearchPage: () => false,
    extractProduct(doc, url) {
      const ld = fromJsonLd(readJsonLd(doc));
      const fields = {
        title: { value: ld.title || (text(one(doc, 'h1')) || (doc && doc.title) || null), selector: ld.title ? 'json-ld' : 'h1' },
        pricePaise: { value: ld.pricePaise !== undefined ? ld.pricePaise : money.toPaise(attr(one(doc, 'meta[property="product:price:amount"]'), 'content') || attr(one(doc, '[itemprop="price"]'), 'content')), selector: 'meta/json-ld' },
        mrpPaise: { value: null, selector: null },
        rating: { value: ld.rating === undefined ? null : ld.rating, selector: 'json-ld' },
        reviewCount: { value: ld.reviewCount === undefined ? null : ld.reviewCount, selector: 'json-ld' },
        productId: { value: ld.productId || model.hashKey(url), selector: 'json-ld/url' },
        brand: { value: ld.brand === undefined ? null : ld.brand, selector: 'json-ld' },
        currency: { value: ld.currency || null, selector: 'json-ld' },
        image: { value: attr(one(doc, 'meta[property="og:image"]'), 'content') || ld.image || null, selector: 'og:image' }
      };
      const result = buildResult('generic', ld.currency || 'INR', 'IN', url, fields);
      if (!ld.title && !ld.pricePaise) {
        result.extractionStatus = 'dom_changed';
        result.warnings.unshift('No schema.org Product data found on this page — MarketLens only reports what it can read.');
      }
      return result;
    },
    extractComparables() { return []; }
  };

  function extractFor(doc, url) {
    const adapter = adapterFor(url);
    if (adapter && (adapter.isProductPage(url) || adapter.isSearchPage(url))) {
      const res = adapter.extractProduct(doc, url);
      res.adapter = adapter.id;
      res.adapterLabel = adapter.label;
      return res;
    }
    const res = GENERIC.extractProduct(doc, url);
    res.adapter = 'generic';
    res.adapterLabel = GENERIC.label;
    res.unsupportedPage = !adapter;
    if (!adapter) res.warnings.unshift('This site has no dedicated adapter yet — showing generic extraction only.');
    return res;
  }

  function scanComparables(doc, url) {
    const adapter = adapterFor(url) || GENERIC;
    const listings = adapter.extractComparables(doc).map(l => Object.assign({ observedAt: Date.now() }, l));
    return { adapter: adapter.id, listings };
  }

  return { ADAPTERS, GENERIC, adapterFor, extractFor, scanComparables, readJsonLd, fromJsonLd, parseWeightG, parseDimsCm };
});
