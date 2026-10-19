# Crawler Free

A keyless, free-hosted, Firecrawl-v2-compatible API: **URL → clean Markdown**, **whole-site crawl**, and **schema-based JSON extraction**. It runs on one Cloudflare Worker on the Free plan.

**Easiest: open https://crawler-free.crawler-free.workers.dev in your browser**, paste a page address, and press Go. You can save a page as a one-click setup and re-run it later with one click, its link, or one terminal command (`irm <link>`). The step-by-step [GUIDE.md](GUIDE.md) covers the web page and copy-paste terminal commands for Windows, Mac and Linux.

- **Base URL:** `https://crawler-free.crawler-free.workers.dev`
- **Source:** https://github.com/artthavv999/crawler-free (MIT, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md))
- **Abuse / opt-out contact:** https://github.com/artthavv999/crawler-free/issues
- **Security issues:** report privately, see [SECURITY.md](SECURITY.md)

No API key, no sign-up. The official Firecrawl JS SDK works unchanged: `new Firecrawl({ apiKey: "fc-keyless", apiUrl: "https://crawler-free.crawler-free.workers.dev" })`.

## Endpoints

| Endpoint | Body | Returns |
|---|---|---|
| `POST /v2/scrape` | `url`, `formats`: any of `"markdown"`, `"links"`, `{ "type": "json", "schema": {…}, "prompt"?: "…" }` (default `["markdown"]`) | `{ success, data: { markdown?, links?, json?, warning?, metadata } }` + header `x-cache: HIT\|MISS` |
| `POST /v2/crawl` | `url`, `limit` (default 10), `maxDiscoveryDepth` (default 2, hops from the start page), `scrapeOptions.formats` (markdown/links) | `{ success, id, url }` |
| `GET /v2/crawl/{id}` | `?skip=N` | `{ success, status: "scraping"\|"completed", completed, total, expiresAt, next, data[] }`, 10 pages per response, follow `next` |
| `POST /v2/setups` | `url`, `mode`: `"text"`, `"links"` or `"facts"`, `fields` (facts: up to 20 names, array or comma-separated) | `{ success, id, run }`; saves settings only, never page content |
| `GET /run/{id}` | `?format=json` (optional) | Runs a saved setup: plain text by default (page text, one link per line, or `name: answer` lines), or the `/v2/scrape` JSON |
| `DELETE /v2/setups/{id}` | — | `{ success }` |
| `GET /` | — | The web page (static files in `public/`) |

Unknown fields are accepted, ignored and listed in `warning`. Errors are `{ "success": false, "code": "...", "error": "..." }`.

Call the API from a server, script or terminal. POST and DELETE requests that a browser marks as coming from another website's page are refused with `403 CROSS_SITE_BLOCKED`; SDKs, curl and PowerShell are unaffected. Request bodies over 64 KB get `413 PAYLOAD_TOO_LARGE`.

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
| JSON extractions | 20 per 24 h, counted from your first request; only fresh AI runs count, not cached answers; shared free AI budget for everyone (`EXTRACT_BUDGET_EXHAUSTED` when spent) |
| Saved setups | 20 new per 24 h; runs count as scrapes; deleted after 30 days without a run |
| Crawls | 5 jobs per 24 h, counted from your first request; `limit` ≤ 100 pages; `maxDiscoveryDepth` ≤ 3; same host, under the start URL's path |
| Page size / time | 5 MB, 15 s, at most 5 redirects |
| JavaScript pages | Rendered by Cloudflare Browser Run only when static HTML is near-empty; one page every 10 s and a small shared daily budget (`RENDER_BUSY` with `Retry-After: 10`, or `RENDER_BUDGET_EXHAUSTED`); crawls retry busy pages themselves |
| Cache | Results cached 1 h by normalised URL + formats |
| Retention | Crawl results deleted after 24 h; saved setups (address + settings only) after 30 days unused; no permanent archive; Workers logs kept 3 days |

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

Security checks run in GitHub Actions on every push and pull request, and weekly: tests, Gitleaks over the whole history, `npm audit`, CodeQL, a check that the built web page matches its sources, and an OWASP ZAP baseline scan of a local instance. Without a Cloudflare login, tests and `wrangler dev` use `wrangler.ci.toml`, which has no Workers AI binding: `CRAWLER_WRANGLER_CONFIG=./wrangler.ci.toml npx vitest run`. Audit: [docs/security-audit.md](docs/security-audit.md).

Web page: the scripts are written in `ui/` and bundled into `public/` with `npm run build:ui` (esbuild; gsap, lenis and ogl are bundled in, nothing loads from a CDN). The built files are committed, so `wrangler deploy` needs no build step. Redesign notes and screenshots: [docs/ui-redesign-notes.md](docs/ui-redesign-notes.md), [docs/screenshots/](docs/screenshots/).
