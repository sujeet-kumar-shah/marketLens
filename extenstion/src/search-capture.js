// MarketLens core module: search-capture.js
//
// Turns a search / category page the seller is ACTUALLY LOOKING AT into an
// observed listing record: DOM order = observed position, prices and ratings
// are read from the card text. Nothing here estimates anything.
//
//   * A listing whose price cannot be read keeps pricePaise = null.
//   * "Rank" means: the position this listing occupied in a search page that
//     was captured at a known time. It is NOT a sales rank and NOT a category
//     rank — Flipkart's internal rank is not observable from a public page.
//   * Summaries (median, quartiles, bands) describe only the captured sample.

(function (root, factory) {
  const isNode = typeof module !== 'undefined' && !!module.exports;
  const require_ = isNode ? require : null;
  const api = factory(require_);
  if (isNode) module.exports = api;
  if (root) { root.MarketLens = root.MarketLens || {}; root.MarketLens.capture = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (require_) {
  'use strict';

  const money = require_ ? require_('./money.js') : globalThis.MarketLens.money;

  const MAX_LISTINGS = 40;

  // ------------------------------------------------------------ url handling
  const SEARCH_HOSTS = [
    { marketplace: 'flipkart', test: /flipkart\.com/i, search: /\/search\b/i },
    { marketplace: 'amazon_in', test: /amazon\.in/i, search: /\/s\b|\/s\?|\/s\/|\/s$/i },
    { marketplace: 'amazon_us', test: /amazon\.com/i, search: /\/s\b|\/s\?|\/s\/|\/s$/i },
    { marketplace: 'meesho', test: /meesho\.com/i, search: /\/search/i }
  ];

  function host(url) {
    for (const h of SEARCH_HOSTS) { if (h.test.test(url)) return h; }
    return null;
  }

  function param(url, name) {
    const m = new RegExp('[?&]' + name + '=([^&#]*)').exec(String(url || ''));
    if (!m) return null;
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')) || null; }
    catch (e) { return m[1] || null; }
  }

  /** Is this URL a search results page (as opposed to a product page)? */
  function isSearchUrl(url) {
    const h = host(url);
    if (!h) return false;
    if (/\/p\//.test(url) || /\/dp\//.test(url)) return false;   // product pages win
    return h.search.test(url) || !!param(url, 'q');
  }

  /**
   * What query does this page represent? Prefers the ?q= parameter; falls back
   * to the page title the caller read from the document. Never invents one.
   */
  function queryForUrl(url, docTitle) {
    const h = host(url);
    const marketplace = h ? h.marketplace : 'generic';
    const q = param(url, 'q');
    if (q) return { marketplace, query: q, kind: 'search' };
    const sid = param(url, 'sid');
    if (sid) return { marketplace, query: sid, kind: 'category' };
    const t = typeof docTitle === 'string' && docTitle.trim() ? docTitle.trim() : null;
    if (t) return { marketplace, query: t, kind: 'category' };
    return { marketplace, query: null, kind: 'page' };
  }

  function fsnFromHref(href) {
    const h = String(href || '');
    // Flipkart's product page reports productId from ?pid=. Prefer the same id
    // here so an observed search position can be matched on the product page.
    const pid = /[?&]pid=([A-Za-z0-9]+)/.exec(h);
    if (pid) return pid[1];
    const m = /\/p\/(itm[0-9A-Za-z]+)/.exec(h);
    return m ? m[1] : null;
  }

  // ------------------------------------------------------------- text parsing
  /** First ₹ amount in a blob of card text. Returns paise or null. */
  function priceFromText(cardText) {
    if (!cardText) return null;
    const m = /₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/.exec(String(cardText));
    if (!m) return null;
    const paise = money.toPaise(m[1]);
    return paise !== null && paise > 0 ? paise : null;
  }

  function reviewCountFromText(cardText) {
    if (!cardText) return null;
    const m = /([0-9][0-9,]*)\s*(?:Ratings?|Reviews?)/i.exec(String(cardText));
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  /** Rating like "4.1" — searched in text with the price/review parts removed. */
  function ratingFromText(cardText) {
    if (!cardText) return null;
    const cleaned = String(cardText)
      .replace(/₹\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/g, ' ')
      .replace(/([0-9][0-9,]*)\s*(?:Ratings?|Reviews?)/gi, ' ');
    const m = /(?:^|[^0-9.])([1-5]\.[0-9])(?:[^0-9]|$)/.exec(cleaned);
    return m ? parseFloat(m[1]) : null;
  }

  // ------------------------------------------------------------ DOM collection
  function slice(list) { return Array.prototype.slice.call(list || []); }

  /**
   * Card titles: ignore empty links and badge-only text ("Trending", "AD").
   * Returns null when nothing readable exists — never a guess.
   */
  function cleanTitle(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length < 4) return null;
    if (/^(trending|bestseller|best seller|sponsored|ad|assured)$/i.test(s)) return null;
    return s;
  }

  /**
   * Raw items in DOM order: { href, title, cardText }.
   * Defensive: any missing method simply yields null, never a guessed value.
   */
  function collectFlipkart(doc) {
    const out = [];
    if (!doc || !doc.querySelectorAll) return out;
    let nodes;
    try { nodes = slice(doc.querySelectorAll('a[href*="/p/itm"]')); } catch (e) { return out; }
    const seen = new Set();
    for (const a of nodes) {
      const href = a.getAttribute ? a.getAttribute('href') : null;
      const fsn = fsnFromHref(href);
      if (!fsn || seen.has(fsn)) continue;
      seen.add(fsn);
      let node = a.parentElement, cardText = null, depth = 0;
      while (node && depth < 6) {
        const t = node.textContent || '';
        if (t.indexOf('₹') > -1) { cardText = t; break; }
        node = node.parentElement;
        depth++;
      }
      const img = a.querySelector ? a.querySelector('img') : null;
      const alt = img && img.getAttribute ? img.getAttribute('alt') : null;
      let title = cleanTitle(alt);
      if (!title && a.getAttribute) title = cleanTitle(a.getAttribute('title'));
      if (!title && node && node.querySelectorAll) {
        for (const link of slice(node.querySelectorAll('a[title]'))) {
          title = cleanTitle(link.getAttribute ? link.getAttribute('title') : null);
          if (title) break;
        }
      }
      if (!title) title = cleanTitle(a.textContent);
      out.push({ href, title, cardText });
    }
    return out;
  }

  /** Generic fallback: links that look like product links on any site. */
  function collectGeneric(doc) {
    const out = [];
    if (!doc || !doc.querySelectorAll) return out;
    let nodes;
    try { nodes = slice(doc.querySelectorAll('a[href]')); } catch (e) { return out; }
    const seen = new Set();
    for (const a of nodes) {
      const href = a.getAttribute ? a.getAttribute('href') : null;
      if (!href || !/\/(p|dp|product|proddetail)\//i.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      let node = a.parentElement, cardText = null, depth = 0;
      while (node && depth < 6) {
        const t = node.textContent || '';
        if (t.indexOf('₹') > -1) { cardText = t; break; }
        node = node.parentElement;
        depth++;
      }
      if (!cardText) continue;                        // no readable price anywhere near: skip
      const img = a.querySelector ? a.querySelector('img') : null;
      const alt = img && img.getAttribute ? img.getAttribute('alt') : null;
      out.push({ href, title: alt || (a.textContent || '').replace(/\s+/g, ' ').trim() || null, cardText });
    }
    return out;
  }

  /** Collect with the marketplace collector first, generic second. */
  function collect(doc, marketplace) {
    if (marketplace === 'flipkart') {
      const fk = collectFlipkart(doc);
      if (fk.length) return fk;
      return collectGeneric(doc);
    }
    return collectGeneric(doc);
  }

  // -------------------------------------------------------------- pure parsing
  /**
   * Raw items (DOM order) -> observed listings with positions.
   * position = order of first appearance. Duplicate FSNs keep the first.
   */
  function parseAnchorItems(items, url) {
    const out = [];
    const seen = new Set();
    let pos = 0;
    for (const item of items || []) {
      if (!item || typeof item !== 'object') continue;
      const productId = fsnFromHref(item.href);
      const dedupeKey = productId || ('t:' + String(item.title || '') + '|' + String(item.cardText || '').slice(0, 40));
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      pos++;
      out.push({
        position: pos,
        productId,
        title: item.title || null,
        pricePaise: priceFromText(item.cardText),
        rating: ratingFromText(item.cardText),
        reviewCount: reviewCountFromText(item.cardText),
        url: item.href ? absoluteUrl(item.href, url) : null
      });
      if (out.length >= MAX_LISTINGS) break;
    }
    return out;
  }

  function absoluteUrl(href, baseUrl) {
    try { return new URL(href, baseUrl).href; }
    catch (e) { return href || null; }
  }

  /** One call for the common path: read the live document, return a capture. */
  function captureFromDocument(doc, url, now) {
    const info = queryForUrl(url, doc && doc.title);
    const items = collect(doc, info.marketplace);
    const listings = parseAnchorItems(items, url);
    return makeCapture({
      marketplace: info.marketplace,
      query: info.query,
      kind: info.kind,
      sourceUrl: url,
      listings,
      now: typeof now === 'number' ? now : Date.now()
    });
  }

  function makeCapture(opts) {
    const o = opts || {};
    return {
      kind: 'search_capture',
      marketplace: o.marketplace || 'generic',
      query: o.query || null,
      pageKind: o.kind || 'search',
      sourceUrl: o.sourceUrl || null,
      observedAt: typeof o.now === 'number' ? o.now : Date.now(),
      listings: (o.listings || []).slice(0, MAX_LISTINGS)
    };
  }

  // -------------------------------------------------------------- statistics
  /** Nearest-rank quantile on a pre-sorted array. Deterministic, documented. */
  function quantile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
  }

  /**
   * Describe ONLY the observed sample. Every field is null when it cannot be
   * computed; counts are integers, never estimates.
   */
  function summarize(listings) {
    const list = Array.isArray(listings) ? listings : [];
    const prices = list.map(l => l && l.pricePaise).filter(p => typeof p === 'number' && p > 0)
      .sort((a, b) => a - b);
    const ratings = list.map(l => l && l.rating).filter(r => typeof r === 'number' && r > 0 && r <= 5);

    const price = prices.length ? {
      count: prices.length,
      minPaise: prices[0],
      maxPaise: prices[prices.length - 1],
      p25Paise: quantile(prices, 0.25),
      medianPaise: quantile(prices, 0.5),
      p75Paise: quantile(prices, 0.75)
    } : null;

    let bands = null;
    if (price && price.minPaise !== price.maxPaise) {
      const cuts = [
        { fromPaise: price.minPaise, toPaise: price.p25Paise },
        { fromPaise: price.p25Paise + 1, toPaise: price.medianPaise },
        { fromPaise: price.medianPaise + 1, toPaise: price.p75Paise },
        { fromPaise: price.p75Paise + 1, toPaise: price.maxPaise }
      ].filter(b => b.fromPaise <= b.toPaise);
      bands = cuts.map(b => ({
        fromPaise: b.fromPaise,
        toPaise: b.toPaise,
        count: prices.filter(p => p >= b.fromPaise && p <= b.toPaise).length
      }));
    } else if (price) {
      bands = [{ fromPaise: price.minPaise, toPaise: price.maxPaise, count: prices.length }];
    }

    return {
      sampleSize: list.length,
      priced: price,
      rating: ratings.length ? {
        count: ratings.length,
        avg: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100
      } : null,
      bands
    };
  }

  /** Position of an FSN inside one capture's listing list. */
  function positionOf(fsn, listings) {
    if (!fsn || !Array.isArray(listings)) return null;
    for (const l of listings) { if (l && l.productId === fsn) return l.position; }
    return null;
  }

  /**
   * Find the most recent capture (out of the stored comparables map) whose
   * listing list contains this FSN. Returns null when the product has never
   * been seen in a captured search page — the caller must say "not observed".
   */
  function findRankInCaptures(comparables, fsn) {
    if (!fsn || !comparables || typeof comparables !== 'object') return null;
    let best = null;
    for (const key of Object.keys(comparables)) {
      const c = comparables[key];
      if (!c || c.kind !== 'search_capture' || !Array.isArray(c.listings)) continue;
      const position = positionOf(fsn, c.listings);
      if (position === null) continue;
      if (!best || (c.observedAt || 0) > (best.observedAt || 0)) {
        best = {
          key,
          query: c.query || null,
          marketplace: c.marketplace || 'generic',
          sourceUrl: c.sourceUrl || null,
          observedAt: c.observedAt || null,
          position,
          sampleSize: c.listings.length
        };
      }
    }
    return best;
  }

  /**
   * Of the priced listings in a capture, what share is at or above this price?
   * Uses only prices actually read. Null when nothing is priced.
   */
  function shareAtOrAbovePct(pricePaise, listings) {
    if (typeof pricePaise !== 'number' || !Array.isArray(listings)) return null;
    const prices = listings.map(l => l && l.pricePaise).filter(p => typeof p === 'number' && p > 0);
    if (!prices.length) return null;
    const atOrAbove = prices.filter(p => p >= pricePaise).length;
    return Math.round((atOrAbove / prices.length) * 1000) / 10;
  }

  return {
    MAX_LISTINGS,
    isSearchUrl, queryForUrl, fsnFromHref, absoluteUrl,
    priceFromText, ratingFromText, reviewCountFromText,
    collectFlipkart, collectGeneric, collect, parseAnchorItems, captureFromDocument, makeCapture,
    quantile, summarize, positionOf, findRankInCaptures, shareAtOrAbovePct
  };
});
