# Price Compare MVP

A serverless API that scrapes Indian e-commerce sites and returns price comparisons for any product query.

**Live URL:** `https://price-compare-mvp.vercel.app/api/compare?q=iphone+15`

---

## Sites Covered

| Site | Status |
|---|---|
| Amazon India | ✅ via ScraperAPI |
| Flipkart | ✅ via ScraperAPI |
| Reliance Digital | ✅ via ScraperAPI |
| Croma | ✅ via ScraperAPI |
| Tata CLiQ | ✅ via ScraperAPI |
| Vijay Sales | ✅ via ScraperAPI |
| Poorvika | ✅ via ScraperAPI |

---

## How It Works

1. Client calls `GET /api/compare?q=<product name>`
2. API fans out requests to all 7 sites in parallel
3. Each site's HTML is fetched via **ScraperAPI** (residential proxy — bypasses bot blocks)
4. Cheerio parses product titles, prices, and links from the HTML
5. Results are deduplicated, scored by relevance, and sorted by price
6. Response returns the lowest price + all results across sites

---

## API Usage

```
GET /api/compare?q=samsung+galaxy+s24
```

**Response shape:**
```json
{
  "query": "samsung galaxy s24",
  "totalResults": 12,
  "lowestPrice": {
    "source": "Flipkart",
    "title": "Samsung Galaxy S24 5G",
    "price": 62999,
    "currency": "INR",
    "availability": "In Stock",
    "url": "https://..."
  },
  "results": [...],
  "meta": {
    "durationMs": 4200,
    "sources": [...]
  }
}
```

**Rate limit:** 10 requests/minute (configurable via `RATE_LIMIT_PER_MINUTE` env var)

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js (Vercel Serverless) |
| HTML parsing | Cheerio |
| Proxy | ScraperAPI (residential IPs, Indian region) |
| Deploy | Vercel (auto-deploy on `main` push) |
| Repo | github.com/sujitjbhagwat/price-compare-mvp |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SCRAPER_API_KEY` | Yes | ScraperAPI key — get free at scraperapi.com (5,000 calls/month) |
| `RATE_LIMIT_PER_MINUTE` | No | Default: 10 |
| `SCRAPE_TIMEOUT_MS` | No | Default: 8000 (25000 when proxy active) |
| `MAX_RESULTS_PER_SITE` | No | Default: 3 |

---

## Limitations (MVP)

- Selectors may drift if sites update their HTML — needs periodic maintenance
- Some sites still return 0 results depending on the query (selector mismatch)
- ScraperAPI free tier: 5,000 calls/month — enough for testing, not production scale
- No frontend — API only

---

## Next Steps (when ready)

- [ ] Fix remaining selector mismatches (Croma, Tata CLiQ, Poorvika)
- [ ] Add a simple frontend (search box + price table)
- [ ] Cache results (Redis / Vercel KV) to reduce API call count
- [ ] Add more sites (Meesho, JioMart, etc.)
- [ ] Upgrade ScraperAPI plan or switch to ZenRows for production scale
