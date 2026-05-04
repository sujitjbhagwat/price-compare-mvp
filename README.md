# Price Compare MVP API

Small Vercel-ready scraping API for testing price comparison.

## Endpoint

```bash
GET /api/compare?q=iphone%2017
```

Example:

```bash
curl "http://localhost:3000/api/compare?q=iphone%2017"
```

Response:

```json
{
  "query": "iphone 17",
  "totalResults": 3,
  "lowestPrice": {
    "source": "Flipkart",
    "title": "Apple iPhone ...",
    "price": 79999,
    "currency": "INR",
    "availability": "Possibly available",
    "url": "https://..."
  },
  "results": []
}
```

## Local run

```bash
npm install
npx vercel dev
```

Then open:

```bash
http://localhost:3000/api/compare?q=iphone%2017
```

## Deploy to Vercel

```bash
npm install -g vercel
vercel
```

## Environment variables

Optional:

```bash
RATE_LIMIT_PER_MINUTE=10
SCRAPE_TIMEOUT_MS=8000
MAX_RESULTS_PER_SITE=3
```

## Important notes

- This is an MVP scraper, not production-grade.
- The rate limiter uses memory only. On Vercel it is per warm function instance, not global.
- For production, use Redis/Upstash for global rate limiting and caching.
- Large e-commerce websites can block scraping or change HTML selectors anytime.
- Prefer affiliate/product APIs for production.
