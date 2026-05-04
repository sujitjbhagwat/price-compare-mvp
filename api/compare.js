import * as cheerio from "cheerio";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULT_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 10);
const REQUEST_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 8000);
const MAX_RESULTS_PER_SITE = Number(process.env.MAX_RESULTS_PER_SITE || 3);

// NOTE: This is intentionally simple for MVP testing.
// On Vercel/serverless, this is per warm function instance, not a true global limiter.
let rateState = globalThis.__PRICE_COMPARE_RATE_LIMIT__;
if (!rateState) {
  rateState = {
    tokens: DEFAULT_LIMIT_PER_MINUTE,
    resetAt: Date.now() + 60_000,
  };
  globalThis.__PRICE_COMPARE_RATE_LIMIT__ = rateState;
}

function applyRateLimit() {
  const now = Date.now();
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE || DEFAULT_LIMIT_PER_MINUTE);

  if (now >= rateState.resetAt) {
    rateState.tokens = limit;
    rateState.resetAt = now + 60_000;
  }

  if (rateState.tokens <= 0) {
    return {
      allowed: false,
      remaining: 0,
      resetInSeconds: Math.ceil((rateState.resetAt - now) / 1000),
    };
  }

  rateState.tokens -= 1;

  return {
    allowed: true,
    remaining: rateState.tokens,
    resetInSeconds: Math.ceil((rateState.resetAt - now) / 1000),
  };
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload, null, 2));
}

function cleanText(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function absoluteUrl(baseUrl, url) {
  if (!url) return null;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

function parsePrice(value = "") {
  const text = cleanText(value);

  // Common Indian e-commerce formats: ₹79,999 / Rs. 79,999 / INR 79,999
  const match = text.match(/(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  if (!match) return null;

  const number = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(number) || number <= 0) return null;

  return Math.round(number);
}

function queryTokens(query) {
  return cleanText(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
}

function relevanceScore(query, title) {
  const titleLc = cleanText(title).toLowerCase();
  const q = cleanText(query).toLowerCase();
  const tokens = queryTokens(query);
  if (!titleLc || tokens.length === 0) return 0;

  let hits = 0;
  for (const token of tokens) {
    if (titleLc.includes(token)) hits += 1;
  }

  let score = hits / tokens.length;
  if (titleLc.includes(q)) score += 0.35;
  return Number(score.toFixed(3));
}

function normalizeProduct(source, product, query) {
  const title = cleanText(product.title);
  const price = typeof product.price === "number" ? product.price : parsePrice(product.priceText);
  const url = product.url || null;

  if (!title || !price || !url) return null;

  return {
    source,
    title,
    price,
    currency: "INR",
    availability: product.availability || "Unknown",
    url,
    relevance: relevanceScore(query, title),
  };
}

function uniqueProducts(products) {
  const seen = new Set();
  const output = [];

  for (const product of products) {
    const key = `${product.source}|${product.title.toLowerCase()}|${product.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(product);
  }

  return output;
}

function extractJsonLdProducts($, sourceName, baseUrl, query) {
  const products = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const blocks = Array.isArray(parsed) ? parsed : [parsed];

      for (const block of blocks) {
        const candidates = [];

        if (block?.["@type"] === "Product") candidates.push(block);
        if (Array.isArray(block?.itemListElement)) {
          for (const item of block.itemListElement) {
            if (item?.item?.["@type"] === "Product") candidates.push(item.item);
          }
        }

        for (const item of candidates) {
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          const price = Number(String(offer?.price || "").replace(/,/g, ""));
          const url = absoluteUrl(baseUrl, item.url || offer?.url);

          const product = normalizeProduct(
            sourceName,
            {
              title: item.name,
              price: Number.isFinite(price) ? price : null,
              priceText: offer?.price,
              availability: offer?.availability?.includes("InStock") ? "In Stock" : "Unknown",
              url,
            },
            query,
          );

          if (product) products.push(product);
        }
      }
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
  });

  return products;
}

function extractGenericProducts($, sourceName, baseUrl, query) {
  const products = [];
  const tokens = queryTokens(query);

  $("a[href]").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    const url = absoluteUrl(baseUrl, href);
    if (!url) return;

    const anchorText = cleanText($a.text() || $a.attr("title") || $a.find("img").attr("alt"));
    if (!anchorText || anchorText.length < 8) return;

    const parentText = cleanText($a.parent().text() + " " + $a.parent().parent().text()).slice(0, 1000);
    const price = parsePrice(parentText);
    if (!price) return;

    const lower = anchorText.toLowerCase();
    const hasAnyToken = tokens.some((token) => lower.includes(token));
    if (!hasAnyToken) return;

    const product = normalizeProduct(
      sourceName,
      {
        title: anchorText,
        price,
        availability: "Possibly available",
        url,
      },
      query,
    );

    if (product) products.push(product);
  });

  return products;
}

function parseCards($, sourceName, baseUrl, query, cardSelector, titleSelectors, priceSelectors, linkSelectors) {
  const products = [];

  $(cardSelector).each((_, card) => {
    const $card = $(card);

    let title = "";
    for (const selector of titleSelectors) {
      title = cleanText($card.find(selector).first().text() || $card.find(selector).first().attr("title"));
      if (title) break;
    }

    let priceText = "";
    for (const selector of priceSelectors) {
      priceText = cleanText($card.find(selector).first().text());
      if (parsePrice(priceText)) break;
    }

    let link = "";
    for (const selector of linkSelectors) {
      link = $card.find(selector).first().attr("href");
      if (link) break;
    }

    const product = normalizeProduct(
      sourceName,
      {
        title,
        priceText,
        availability: priceText ? "Possibly available" : "Unknown",
        url: absoluteUrl(baseUrl, link),
      },
      query,
    );

    if (product) products.push(product);
  });

  return products;
}

const SOURCES = [
  {
    name: "Amazon India",
    baseUrl: "https://www.amazon.in",
    searchUrl: (q) => `https://www.amazon.in/s?k=${encodeURIComponent(q)}`,
    parse: ($, query, baseUrl) => [
      ...parseCards(
        $,
        "Amazon India",
        baseUrl,
        query,
        '[data-component-type="s-search-result"]',
        ["h2 span", "h2 a span"],
        [".a-price .a-offscreen", ".a-price-whole"],
        ["h2 a", "a.a-link-normal.s-no-outline"],
      ),
      ...extractJsonLdProducts($, "Amazon India", baseUrl, query),
    ],
  },
  {
    name: "Flipkart",
    baseUrl: "https://www.flipkart.com",
    searchUrl: (q) => `https://www.flipkart.com/search?q=${encodeURIComponent(q)}`,
    parse: ($, query, baseUrl) => [
      ...parseCards(
        $,
        "Flipkart",
        baseUrl,
        query,
        'div[data-id], div._1AtVbE, div[data-tkid]',
        ["div.KzDlHZ", "div._4rR01T", "a.IRpwTa", "a.s1Q9rs", "a.WKTcLC", "a[title]"],
        ["div.Nx9bqj", "div._30jeq3", "div._25b18c", "div.hl05eU"],
        ["a.CGtC98", "a._1fQZEK", "a.IRpwTa", "a.s1Q9rs", "a.WKTcLC", "a[href]"],
      ),
      ...extractJsonLdProducts($, "Flipkart", baseUrl, query),
    ],
  },
  {
    name: "Croma",
    baseUrl: "https://www.croma.com",
    searchUrl: (q) => `https://www.croma.com/searchB?q=${encodeURIComponent(q)}%3Arelevance&text=${encodeURIComponent(q)}`,
    parse: ($, query, baseUrl) => [
      ...parseCards(
        $,
        "Croma",
        baseUrl,
        query,
        ".product-item, .cp-product, li.product-item, div[data-testid='product-card']",
        [".product-title", ".product-title a", "h3", "h2", "a[title]"],
        [".amount", ".new-price", ".price", ".product-price", ".cp-price"],
        [".product-title a", "a[href]"],
      ),
      ...extractJsonLdProducts($, "Croma", baseUrl, query),
      ...extractGenericProducts($, "Croma", baseUrl, query),
    ],
  },
  {
    name: "Reliance Digital",
    baseUrl: "https://www.reliancedigital.in",
    searchUrl: (q) => `https://www.reliancedigital.in/search?q=${encodeURIComponent(q)}`,
    parse: ($, query, baseUrl) => [
      ...parseCards(
        $,
        "Reliance Digital",
        baseUrl,
        query,
        ".sp__product, .product-card, li, div[data-testid='product-card']",
        [".sp__name", ".product-card-title", "h3", "h2", "a[title]"],
        [".sp__price", ".price", ".product-price", "span"],
        ["a[href]"],
      ),
      ...extractJsonLdProducts($, "Reliance Digital", baseUrl, query),
      ...extractGenericProducts($, "Reliance Digital", baseUrl, query),
    ],
  },
  {
    name: "Vijay Sales",
    baseUrl: "https://www.vijaysales.com",
    searchUrl: (q) => `https://www.vijaysales.com/search/${encodeURIComponent(q)}`,
    parse: ($, query, baseUrl) => [
      ...parseCards(
        $,
        "Vijay Sales",
        baseUrl,
        query,
        ".productbox, .product-list, .product-item, .product-card, li",
        [".product-name", ".product_name", ".product-title", "h3", "h2", "a[title]"],
        [".Price", ".price", ".product-price", ".offer-price", "span"],
        ["a[href]"],
      ),
      ...extractJsonLdProducts($, "Vijay Sales", baseUrl, query),
      ...extractGenericProducts($, "Vijay Sales", baseUrl, query),
    ],
  },
  {
    name: "Tata CLiQ",
    baseUrl: "https://www.tatacliq.com",
    searchUrl: (q) => `https://www.tatacliq.com/search/?searchCategory=all&text=${encodeURIComponent(q)}`,
    parse: ($, query, baseUrl) => [
      ...parseCards(
        $,
        "Tata CLiQ",
        baseUrl,
        query,
        ".ProductModule__base, .product-card, .PlpComponent__base, li, div",
        [".ProductDescription__description", ".ProductModule__productName", "h3", "h2", "a[title]"],
        [".ProductDescription__priceHolder", ".ProductModule__price", ".price", "span"],
        ["a[href]"],
      ),
      ...extractJsonLdProducts($, "Tata CLiQ", baseUrl, query),
      ...extractGenericProducts($, "Tata CLiQ", baseUrl, query),
    ],
  },
  {
    name: "Poorvika",
    baseUrl: "https://www.poorvika.com",
    searchUrl: (q) => `https://www.poorvika.com/search?q=${encodeURIComponent(q)}`,
    parse: ($, query, baseUrl) => [
      ...parseCards(
        $,
        "Poorvika",
        baseUrl,
        query,
        ".product-card, .product-item, .grid__item, li",
        [".product-card__title", ".product-title", "h3", "h2", "a[title]"],
        [".price", ".price-item", ".money", "span"],
        ["a[href]"],
      ),
      ...extractJsonLdProducts($, "Poorvika", baseUrl, query),
      ...extractGenericProducts($, "Poorvika", baseUrl, query),
    ],
  },
];

function buildFetchUrl(targetUrl) {
  const apiKey = process.env.SCRAPER_API_KEY || "";
  if (!apiKey) return { fetchUrl: targetUrl, usingProxy: false };

  // ScraperAPI: render=false (faster, HTML-only), country_code=in for Indian prices
  const proxy = `http://api.scraperapi.com?api_key=${apiKey}&country_code=in&url=${encodeURIComponent(targetUrl)}`;
  return { fetchUrl: proxy, usingProxy: true };
}

async function fetchHtml(url) {
  const { fetchUrl, usingProxy } = buildFetchUrl(url);
  const controller = new AbortController();
  // ScraperAPI can take longer — give it more time when proxy is active
  const timeout = usingProxy ? Math.max(REQUEST_TIMEOUT_MS, 25000) : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: usingProxy
        ? {} // ScraperAPI sets its own headers
        : {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-IN,en;q=0.9",
            "Cache-Control": "no-cache",
          },
    });

    const html = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      html,
      usingProxy,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeSource(source, query) {
  const searchUrl = source.searchUrl(query);

  try {
    const fetched = await fetchHtml(searchUrl);

    if (!fetched.ok) {
      return {
        source: source.name,
        ok: false,
        error: `HTTP ${fetched.status}`,
        searchUrl,
        results: [],
      };
    }

    const $ = cheerio.load(fetched.html);
    const parsed = source.parse($, query, source.baseUrl);

    const results = uniqueProducts(parsed)
      .filter((p) => p.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || a.price - b.price)
      .slice(0, MAX_RESULTS_PER_SITE);

    return {
      source: source.name,
      ok: true,
      error: null,
      searchUrl,
      results,
    };
  } catch (error) {
    return {
      source: source.name,
      ok: false,
      error: error?.name === "AbortError" ? "Timeout" : error?.message || "Unknown error",
      searchUrl,
      results: [],
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, {
      error: "Method not allowed. Use GET /api/compare?q=iphone",
    });
  }

  const rate = applyRateLimit();
  res.setHeader("X-RateLimit-Limit", String(process.env.RATE_LIMIT_PER_MINUTE || DEFAULT_LIMIT_PER_MINUTE));
  res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
  res.setHeader("X-RateLimit-Reset-In-Seconds", String(rate.resetInSeconds));

  if (!rate.allowed) {
    return json(res, 429, {
      error: "Rate limit reached",
      message: "Try again after the reset window.",
      resetInSeconds: rate.resetInSeconds,
    });
  }

  const query = cleanText(req.query.q || req.query.query || "");

  if (!query) {
    return json(res, 400, {
      error: "Missing query",
      example: "/api/compare?q=iphone%2017",
    });
  }

  const startedAt = Date.now();

  const settled = await Promise.allSettled(SOURCES.map((source) => scrapeSource(source, query)));
  const sourceResults = settled.map((item) =>
    item.status === "fulfilled"
      ? item.value
      : { source: "Unknown", ok: false, error: item.reason?.message || "Failed", results: [] },
  );

  const results = uniqueProducts(sourceResults.flatMap((s) => s.results))
    .sort((a, b) => a.price - b.price || b.relevance - a.relevance)
    .map(({ relevance, ...publicProduct }) => publicProduct);

  const lowestPrice = results.length > 0 ? results[0] : null;

  return json(res, 200, {
    query,
    totalResults: results.length,
    lowestPrice,
    results,
    meta: {
      requestLimitRemaining: rate.remaining,
      rateLimitResetInSeconds: rate.resetInSeconds,
      durationMs: Date.now() - startedAt,
      note: "MVP scraper. Some sites may block requests or change HTML selectors.",
      sources: sourceResults.map((s) => ({
        source: s.source,
        ok: s.ok,
        error: s.error,
        count: s.results.length,
      })),
    },
  });
}
