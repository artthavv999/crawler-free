# Crawler Free — design

Keyless, $0, Firecrawl-v2-shaped `scrape` / `crawl` / `json` API on one Cloudflare Worker (`crawler-free`).
Clean-room: Firecrawl and Scrapling were read for design only; no code copied or translated.
Reference clones: `_ref/firecrawl` @ acd9d41 (2026-10-17), `_ref/Scrapling` @ 7a68493 (2026-10-11).

## 1. API subset (names exactly as in `apps/api/src/controllers/v2/types.ts`)
- `POST /v2/scrape` body: `url` (required, http/https) · `formats` (default `["markdown"]`; items `"markdown"`, `"links"`, `{type:"json", schema, prompt?}`; a string `"x"` ≡ `{type:"x"}` as in Firecrawl; json **requires** `schema`). `origin`/`integration` accepted silently (the SDK injects `origin` into every POST). Any other key or format: ignored, named in `warning`. (Firecrawl itself is `.strict()` → 400 on unknown keys; the brief asks for lenient.)
- Scrape 200: `{success:true, data:{markdown?, links?:string[], json?, warning?, metadata:{title, description, language, ogTitle, ogDescription, ogImage, ogUrl, ogSiteName, sourceURL, url, statusCode, proxyUsed:"basic"}}}`. `sourceURL` = requested URL, `url` = final URL after redirects (Firecrawl semantics).
- `POST /v2/crawl` body: `url` (required) · `limit` (default 10, clamped to ≤ 100, raised from 50 at the user's request; Firecrawl default 10000) · `maxDiscoveryDepth` (default 2, clamped to ≤ 3; **hops**, seed and sitemap URLs = 0, same as Firecrawl) · `scrapeOptions.formats` (markdown/links only). Rest → `warning`.
- Crawl 200: `{success:true, id:<uuid>, url:"<origin>/v2/crawl/<id>"}`.
- `GET /v2/crawl/{id}` 200: `{success:true, status:"scraping"|"completed", completed, total, creditsUsed:0, expiresAt:<ISO, +24 h>, next:"<origin>/v2/crawl/<id>?skip=N"|null, data:Document[]}`; 10 docs per page, `next` only while more finished docs remain (SDK follows `next` until null). Unknown id → 404.
- Not built: DELETE/errors/WS crawl routes, `GET /v2/scrape/:id`, map, search, agent, and all other formats/options.
- Errors `{success:false, code, error}`: `BAD_REQUEST` 400 · `URL_BLOCKED` 400 (SSRF) · `ROBOTS_DISALLOWED` 403 · `BLOCKED` 403 (target 401/402/403/429 or `cf-mitigated: challenge`) · `RATE_LIMITED` 429 + `Retry-After` · `SCRAPE_TIMEOUT` 408 · `SCRAPE_FAILED` 500 · `EXTRACT_FAILED` 500 · `RENDER_BUSY` / `RENDER_BUDGET_EXHAUSTED` / `EXTRACT_BUDGET_EXHAUSTED` / `DISABLED` 503 · `NOT_FOUND` 404. **Never 502**: the SDK auto-retries 502 three times (`apps/js-sdk/firecrawl/src/v2/utils/httpClient.ts`), which would triple upstream load.

## 2. What each reference contributes
| Source | We take | We deliberately differ |
|---|---|---|
| Firecrawl (AGPL, design only) | Endpoint paths, field names, envelopes, crawl job + polling + `next` paging; depth = hops (`scrape-worker.ts:799`, `crawler.ts:186`); dedupe drops `#hash` and folds `/index.html`, `/index.php` (`crawl-redis.ts:606-709`); link scope = under the start URL's path; sitemaps from robots `Sitemap:` then `/sitemap.xml` (`crawler.ts:563-739`); fall through to a browser when static Markdown is empty (`scrapeURL/index.ts:747-1117`) | No code. No fire-engine, stealth proxy retry on 401/403/429 (ours: `BLOCKED`), engine overlap. Firecrawl allows all on robots non-2xx and checks robots on single scrapes only under a flag; ours checks always, 5xx = disallow. Firecrawl's `links` come from post-main-content HTML (would drop the `/page/2/` pager in `<nav>`); ours from the whole page |
| Scrapling (BSD-3) | Sanitizer rule set (drop script/style/noscript/svg/template, inline-hidden styles, `aria-hidden`, zero-width + control chars); dedupe key computed at enqueue (drop fragment, sort query); robots `Crawl-delay` as per-host floor | Robots ON always; robots 5xx = disallow (Scrapling: allow); hidden-style match case/space-insensitive (Scrapling: exact substring, misses `DISPLAY:NONE`, hits `opacity:0.5`); also drop `[hidden]`; depth cap; absolute links; no TLS impersonation / fake referer |
| Workers `HTMLRewriter` (native) | Drops chrome/hidden subtrees and reads metadata in one streaming pass; Markdown is then made by whole-string regex passes | Replaced Defuddle + linkedom in Phase 1: they cost 93–1,383 ms CPU per page vs the 10 ms Free limit |
| robots-parser (MIT) | RFC 9309 matching, `Crawl-delay` | — |

## 3. Architecture (deltas from the brief's default are marked ⚑)
- **Scrape**: validate URL → robots (per origin, D1-cached 1 h; fetch failures cached 5 min) → `fetch` `redirect:"manual"`, re-validate + robots-check every hop (≤5) → 401/402/403/challenge ⇒ `BLOCKED` → HTMLRewriter removes page-chrome tags/roles, class/id tokens that start with a chrome word (`sidebar-left`, not `has-sidebar`), page-level `<header>/<footer>/<aside>` (kept inside article/section/main, per HTML landmark rules) and hidden elements (no content scoring, like Firecrawl) → regex HTML→Markdown → links from the whole page, made absolute, http(s) only, deduped → metadata.
- **JS fallback** ⚑: if the page is 2xx, the extracted word count is `< 10` and the HTML has `<script>` (measured: `/js/` = 1 word, example.com = 25 words and now ships a script), call Browser Run **`/content`** (rendered HTML) instead of `/markdown`, then run the same pipeline. Reason: Quick Actions are limited to 1 request / 10 s *in total*; `/markdown` + `/links` would be two calls and two output styles. Upstream 429 "limit exceeded for today" or missing token ⇒ `RENDER_BUDGET_EXHAUSTED`; any other 429 (the 1-per-10-s rate) ⇒ `RENDER_BUSY` + `Retry-After: 10`, which the crawl consumer retries 15–30 s later, up to 5 attempts. We pass our honest UA as `userAgent`.
- **Evidence for the trigger** (0e): `quotes.toscrape.com/` raw HTML has 10 `div.quote`, 0 `<script>`; `/js/` raw HTML has 0 `div.quote` — its quote text exists only inside a `<script>` data array, and REA's rendered capture shows 10 `div.quote` after JS. So `/js/` needs rendering, `/` does not, and "text present in raw HTML" is the wrong signal.
- **URL key** (dedupe + cache): WHATWG-normalised, `#hash` dropped, query params sorted, trailing `/index.html|/index.php` → `/`. Crawl scope: same hostname and path under the seed's directory.
- **Crawl**: `POST` validates seed (+robots), inserts job row, reads the first sitemap from robots `Sitemap:` else `/sitemap.xml` (regex `<loc>`, in scope; a sitemap index is followed one level, up to 10 child sitemaps), enqueues seed + sitemap URLs (≤ `limit`). Consumer (`max_batch_size=1`): scrape one URL, store page (Markdown capped at 200 KB), then **one** statement `INSERT OR IGNORE … SELECT … FROM json_each(?) WHERE url NOT IN (job's urls) LIMIT limit − COUNT(*) RETURNING url` (D1 allows only 50 queries/invocation and 100 bound params), enqueue the returned URLs only if depth+1 ≤ `maxDiscoveryDepth`. Never throws: failures mark the page `failed` and ack, so status always converges. Status is computed on read: `completed` = done pages, `total` = pages not failed, `status` = `completed` once nothing is queued — no job-state writes. Crawl pages are scraped through the same `scrape()` (robots, SSRF, cache) with `links` forced on for discovery.
- **Crawl-delay** ⚑: a per-host `next_slot` column (robots table) is advanced atomically when enqueuing k links; message i gets `delaySeconds = slot − now + i·delay` (delay = robots `Crawl-delay`, default 1 s, max 10 s). Reason: plain per-message delay lets sibling pages burst the same host.
- **JSON**: `json` format → Workers AI JSON Mode on sanitized Markdown truncated to ~12 k chars; parse; check every `required` key (or every `properties` key if none). Not allowed inside crawl `scrapeOptions` (would drain the 10 k neuron/day pool).
- **Limits** ⚑ (all D1, one `INSERT … ON CONFLICT DO UPDATE SET n=n+1 RETURNING n`): key = `CF-Connecting-IP` IPv4, or IPv6 /64. scrape 20/min, crawl 5/day, json 20/day; `limit` ≤ 100 (default 10), depth ≤ 3 (default 2); body ≤ 5 MB; fetch timeout 15 s; ≤ 5 redirects. Reason: Rate Limiting binding allows only 10/60 s periods (no daily limits), is per-location and eventually consistent, and Free availability is still undocumented.
- **Cache** ⚑: D1 table, key = SHA-256(normalized URL + formats + schema), TTL 1 h, `x-cache: HIT|MISS`. Reason: Cache API is a no-op on `*.workers.dev`. Skip caching bodies over 1 MB (D1 row cap 2 MB).
- **Cron** ⚑ (hourly, not daily): delete jobs/pages > 24 h, expired cache, robots and counter rows. Reason: a Free D1 database is capped at 500 MB; a day of expired 1 h cache rows could exceed it.
- Kill switch: `DISABLED="1"` var ⇒ 503 everywhere. Errors: `{success:false, code, error}`. Unknown fields: ignored and listed in `warning`.
- `shortcut:` Turnstile gate for crawl/json deferred. Comments use `shortcut:` (brief); `/ponytail-debt` looks for `ponytail:`, so Phase 4 falls back to grep if it finds none.

## 4. SSRF guard (`guard.ts`)
WHATWG `URL` (normalises `127.1`, `2130706433`, `0x7f000001` → `127.0.0.1`); allow `http:`/`https:`, port `""|80|443`; reject userinfo, any IPv4/IPv6 literal, dot-less hosts, `localhost`, `.localhost .local .internal .lan .home.arpa`, and our own host. Resolve A + AAAA via DoH (`cloudflare-dns.com/dns-query`, JSON); require ≥1 answer; every answer must be global. IPv4 deny: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4. IPv6 **allow-list**: only 2000::/3, minus 2001:0::/32 (Teredo), 2001:db8::/32, 2002::/16 (6to4) — this alone excludes ::1, ::ffff:0:0/96, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96. Residual risks (documented): DNS rebinding between our DoH check and Workers' own resolution; Browser Run's sub-resource fetches happen on Cloudflare's network, not ours.

## 5. Modules (`src/`, ≤ 800 counted lines; actual after Phase 4)
| File | Does | Lines |
|---|---|---|
| `index.ts` | router (`fetch`, `queue`, `scheduled`), kill switch, limits per route, error envelope, unknown-field warning | 115 |
| `guard.ts` | URL validation, DoH (60 s memo), IP checks, `safeFetch` (manual redirects, timeout, size cap, UA) | 85 |
| `robots.ts` | robots fetch/parse/cache, 4xx allow / 5xx disallow, per-isolate memo | 35 |
| `scrape.ts` | cache (UTF-8 byte guard), block detection, HTMLRewriter strip + regex Markdown, links, metadata, Browser Run fallback | 136 |
| `json.ts` | Workers AI JSON Mode (`llama-3.2-3b-instruct`) + required keys, one retry | 34 |
| `crawl.ts` | create job, sitemap seed, robots/asset link filter, claim/dedupe, crawl-delay slots, queue consumer (row-size guard), status + `next` paging | 98 |
| `limits.ts` | client key (IPv4 / IPv6 /64), D1 counters, `Retry-After` | 24 |
| `setups.ts` | saved setups (address + mode + fields), `/run/{id}` plain-text runner, 30-day expiry | 39 |
| **total** | | **566** |
Plus `public/` (web page: `index.html`, `style.css`, `_headers` CSP, fonts, and scripts built from `ui/` by `npm run build:ui`), served as Workers static assets. Added at the user's request after Phase 4 (the brief had excluded UI); it only calls the API above, so every limit and rule still applies. Redesigned on 2026-10-19 (dark theme, result tabs, WebGL hero with static fallbacks); see [ui-redesign-notes.md](ui-redesign-notes.md).
Plus `schema.sql` (D1), `wrangler.toml`, `test/units.test.ts` (URL validator, robots, normalisation, rate limiter, extractor, crawl claim).
JSON model note: the 8B models on the JSON Mode docs page were deprecated on 2026-05-30 (Workers AI error 5028); `llama-3.2-3b-instruct` is the smallest current model that passed the acceptance test.

## 6. Fact check (0d, 13 of 15 fetches; checked 2026-10-17)
| Fact | Still true? | Source |
|---|---|---|
| Workers Free: 100k req/day, 10 ms CPU, 50 subrequests, 128 MB | Yes (also: fetch wait not CPU; queue consumer 15 min wall; 5 cron triggers/account; Cache API calls count as subrequests) | https://developers.cloudflare.com/workers/platform/limits/ |
| Browser Run REST `/markdown /json /links /scrape /crawl` | Yes, plus `/content /screenshot /pdf /snapshot /accessibilityTree`; path `accounts/<id>/browser-run/<action>`; token perm "Browser Run - Edit"; `X-Browser-Ms-Used` header | https://developers.cloudflare.com/browser-run/quick-actions/ , …/quick-actions/markdown-endpoint/ |
| Browser Run Free: 10 min/day, 3 concurrent, 1 req/10 s, `/crawl` 5 jobs × 100 pages | Yes (3 concurrent applies to Sessions only); over-limit = HTTP 429 | https://developers.cloudflare.com/browser-run/limits/ |
| Browser Run self-identifies as bot, no bypass | Yes ("always be identified as a bot"); `userAgent` settable | …/quick-actions/markdown-endpoint/ |
| Queues 10k ops/day, 24 h retention, on Free | Yes | https://developers.cloudflare.com/workers/platform/pricing/ |
| D1 5M read / 100k written / 5 GB per day | Yes, but **5 GB is per account; one Free DB max 500 MB**; row ≤ 2 MB; 50 queries/invocation; 100 bound params | same; https://developers.cloudflare.com/d1/platform/limits/ |
| KV 1k writes/day | Yes | same |
| Workers AI 10k neurons/day; JSON Mode no streaming | Yes / Yes | https://developers.cloudflare.com/workers-ai/platform/pricing/ , https://developers.cloudflare.com/workers-ai/features/json-mode/ |
| Rate Limiting binding on Free | **Still undocumented**; periods 10/60 s only; per-location, eventually consistent; open report of non-enforcement on workers.dev | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ , https://github.com/cloudflare/workers-sdk/issues/16097 |
| Cache API on `*.workers.dev` | **Confirmed no-op** (works on custom domains only) | https://developers.cloudflare.com/r2/examples/cache-api/ , https://developers.cloudflare.com/workers/runtime-apis/cache/ |
| JSON Mode models | llama-3.3-70b-fp8-fast, llama-3-8b, llama-3.1-8b, hermes-2-pro-mistral-7b, deepseek-coder-6.7b, deepseek-r1-distill-qwen-32b | json-mode page |
| Firecrawl JS SDK name / `apiUrl` | `@mendable/firecrawl-js` 4.46.0, MIT (also published as `firecrawl`); `new Firecrawl({apiKey, apiUrl})` works, no `fc-` prefix check, Bearer sent only if key non-empty ⇒ **SDK acceptance test applies** | npm registry (`npm view`); `apps/js-sdk/firecrawl/src/v2/client.ts:154-172` |

## 7. Facts that changed or sharpened (and what they change)
- Cache API no-op on workers.dev → cache in D1 (≈1 write per cache miss).
- Rate Limiting binding can't express per-day limits and isn't reliably enforced → all limits in D1 (1 write per request).
- `llama-3.1-8b-instruct-fp8-fast` (the research's cost basis) is **not** JSON-Mode capable → use `@cf/meta/llama-3.1-8b-instruct` (25,608 in / 75,147 out neurons per M tokens): a 3 k-token page ≈ 85 neurons ⇒ ~115 extractions/day for everyone, the low end of the research estimate.
- Browser Run docs moved `browser-rendering` → `browser-run`; 1 Quick Action / 10 s total → use `/content` once instead of `/markdown` + `/links`.
- Tooling: `@cloudflare/vitest-pool-workers@0.23.0` peers `vitest@^4.1` (latest vitest is 5.0.5) → pin vitest 4.x. TypeScript latest is 7.0.2. `defuddle@0.19.5` (`./node` export takes a linkedom `Document`; may need `nodejs_compat` — verify in Phase 1).
- Test sites: `quotes.toscrape.com` and `books.toscrape.com` both 404 on `/robots.txt` (⇒ allow) and `/sitemap.xml`.
- Phase 1 tooling: the test pool's workerd supports compat dates ≤ 2026-08-22, so `compatibility_date = 2026-08-15`; `@cloudflare/vitest-pool-workers` is deprecated in favour of `@cloudflare/vitest-plugin` (works; switching needs your OK).
- **CPU (live `wrangler tail`, same 13 uncached pages each round):** Defuddle + linkedom 93–1,383 ms (typical ~160) → HTMLRewriter with JS per element/text 5–289 (median 24) → native strip + regex Markdown + per-isolate DNS/robots memo **7–45 ms, median 12** (Wikipedia 45). Profile (local workerd): each JS↔native callback costs µs; per-text callbacks and `onEndTag` were 90 % of the cost, plain parsing is 0.2 ms for a 51 KB page. Remaining ~7–10 ms is fixed per-request overhead of the subrequests (DoH ×2, robots, page). No request has been rejected for CPU so far; Free enforces 10 ms with some tolerance, so large pages are the known risk.
- Defuddle findings kept for the record: it needs `useAsync:false` (its async extractors fetch third-party APIs with browser-like UAs), wrangler bundles turndown's browser build (needs `window.DOMParser`), and its clutter list deletes `.author`.
