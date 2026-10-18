# Crawler Free

A keyless, free-hosted, Firecrawl-v2-compatible API: **URL → clean Markdown**, **whole-site crawl**, and **schema-based JSON extraction**. It runs on one Cloudflare Worker on the Free plan.

**New here? Start with the step-by-step [GUIDE.md](GUIDE.md)**: copy-paste commands for Windows, Mac and Linux.

- **Base URL:** `https://crawler-free.crawler-free.workers.dev`
- **Source:** https://github.com/artthavv999/crawler-free (MIT, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md))
- **Abuse / opt-out contact:** https://github.com/artthavv999/crawler-free/issues

No API key, no sign-up. The official Firecrawl JS SDK works unchanged: `new Firecrawl({ apiKey: "fc-keyless", apiUrl: "https://crawler-free.crawler-free.workers.dev" })`.

## Endpoints

| Endpoint | Body | Returns |
|---|---|---|
| `POST /v2/scrape` | `url`, `formats`: any of `"markdown"`, `"links"`, `{ "type": "json", "schema": {…}, "prompt"?: "…" }` (default `["markdown"]`) | `{ success, data: { markdown?, links?, json?, warning?, metadata } }` + header `x-cache: HIT\|MISS` |
| `POST /v2/crawl` | `url`, `limit` (default 10), `maxDiscoveryDepth` (default 2, hops from the start page), `scrapeOptions.formats` (markdown/links) | `{ success, id, url }` |
| `GET /v2/crawl/{id}` | `?skip=N` | `{ success, status: "scraping"\|"completed", completed, total, expiresAt, next, data[] }`, 10 pages per response, follow `next` |

Unknown fields are accepted, ignored and listed in `warning`. Errors are `{ "success": false, "code": "...", "error": "..." }`.

```bash
curl -X POST https://crawler-free.crawler-free.workers.dev/v2/scrape -H "content-type: application/json" -d '{"url":"https://quotes.toscrape.com/","formats":["markdown","links"]}'
```
```bash
curl -X POST https://crawler-free.crawler-free.workers.dev/v2/crawl -H "content-type: application/json" -d '{"url":"https://books.toscrape.com/","limit":20}'
```
```bash
curl -X POST https://crawler-free.crawler-free.workers.dev/v2/scrape -H "content-type: application/json" -d '{"url":"https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html","formats":[{"type":"json","schema":{"type":"object","properties":{"title":{"type":"string"},"price":{"type":"string"},"availability":{"type":"string"}},"required":["title","price","availability"]}}]}'
```
PowerShell: `Invoke-RestMethod -Method Post -Uri https://crawler-free.crawler-free.workers.dev/v2/scrape -ContentType application/json -Body '{"url":"https://quotes.toscrape.com/"}'`

## Limits (per IPv4 address or IPv6 /64)

| What | Limit |
|---|---|
| Scrapes | 20 per minute (`429` + `Retry-After`) |
| JSON extractions | 20 per day; shared free AI budget for everyone (`EXTRACT_BUDGET_EXHAUSTED` when spent) |
| Crawls | 5 jobs per day; `limit` ≤ 50 pages; `maxDiscoveryDepth` ≤ 3; same host, under the start URL's path |
| Page size / time | 5 MB, 15 s, at most 5 redirects |
| JavaScript pages | Rendered by Cloudflare Browser Run only when static HTML is near-empty; small shared daily budget (`RENDER_BUDGET_EXHAUSTED`) |
| Cache | Results cached 1 h by normalised URL + formats |
| Retention | Crawl results deleted after 24 h; no permanent archive; Workers logs kept 3 days |

## How it behaves on your site

- **User-Agent:** `CrawlerFree/0.1 (+https://github.com/artthavv999/crawler-free)`. JS rendering goes through Cloudflare Browser Run, which always identifies itself as a bot.
- **robots.txt (RFC 9309):** always obeyed, matched on the `CrawlerFree` token, for every request and every redirect hop. `4xx` = allowed, `5xx` or unreachable = fully disallowed. Rules are cached for 1 h. `Crawl-delay` is honoured (default 1 s, max 10 s).
- **Blocked means blocked:** on `401`, `402`, `403`, `429` or a challenge page we return `BLOCKED` and never retry, rotate or spoof.
- To opt out, disallow `CrawlerFree` in robots.txt, or open an issue at the contact above.

## Not supported

Search, map, agent, screenshots, PDFs, page actions, logins, forms, caller-supplied headers or cookies, proxies, anti-bot or CAPTCHA bypass, and "extract all emails/phones". Only public `http`/`https` URLs on ports 80/443; private, local and IP-literal addresses are refused (SSRF guard, every DNS answer checked).

## Self-hosting (Cloudflare Free, $0)

```bash
npm install
```
```bash
npx wrangler login
```
```bash
npx wrangler d1 create crawler-free
```
Put the printed `database_id` into `wrangler.toml`, then:
```bash
npx wrangler d1 execute crawler-free --remote --file schema.sql
```
```bash
npx wrangler queues create crawler-free
```
```bash
npx wrangler deploy
```
Optional JS rendering: `npx wrangler secret put CF_ACCOUNT_ID` and `npx wrangler secret put CF_BROWSER_TOKEN` (API token with "Browser Run - Edit"). Kill switch: set `DISABLED = "1"` in `wrangler.toml` and deploy; every endpoint and queued crawl stops.

Development: `npx tsc --noEmit` and `npx vitest run`. Design notes: [docs/DESIGN.md](docs/DESIGN.md).
