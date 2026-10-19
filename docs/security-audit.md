# Crawler Free security audit (2026-10-19)

Scope: everything in this repository: the Worker (`src/`), the web page (`public/`, `ui/`), config, dependencies and git
history, plus read-only checks against the live deployment. Nothing intrusive was run against production. Values of
secrets are never printed here.

## Architecture

- **One Cloudflare Worker** (`src/index.ts`, TypeScript, no framework) on Workers Free, at
  `crawler-free.crawler-free.workers.dev`. Static files in `public/` are served by Workers Static Assets with
  `public/_headers` (strict CSP); every other path reaches the Worker.
- **Public, keyless API by design** (Firecrawl v2 subset): `POST /v2/scrape`, `POST /v2/crawl`, `GET /v2/crawl/{id}`,
  `POST /v2/setups`, `GET /run/{id}`, `DELETE /v2/setups/{id}`. No accounts, no sessions, no cookies. Crawl jobs and saved
  setups are capability URLs: UUIDv4 job IDs, 10-character random setup IDs (about 50 bits).
- **Data:** D1 (rate-limit counters, 1 h result cache, robots cache, crawl jobs and pages kept 24 h, saved setups kept
  30 days after the last run). All queries are prepared statements with bound parameters.
- **Outbound:** fetches arbitrary public web pages (the product), DoH lookups to cloudflare-dns.com, Cloudflare Browser
  Run REST API (account ID and API token are Worker secrets), and Workers AI (Llama 3.2 3B, JSON mode) for facts.
- **Async:** Cloudflare Queues (one page per message) and an hourly cron for cleanup.
- **Sensitive operations:** server-side fetching of user-supplied URLs (SSRF surface), an LLM fed untrusted page text,
  and shared free daily budgets (AI neurons, browser minutes, queue operations, 100k Worker requests).
- **No** file uploads, payments, logins, cookies or GitHub Actions (there was no `.github/` directory).

**Authentication:** none, and none is needed: the service is intentionally public and keyless (that is the product
brief). Protection relies on per-connection rate limits, the SSRF guard and robots.txt. No login system is proposed.

## Findings, most severe first

| # | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| F1 | **Medium** | Other websites can make visitors' browsers call the API (cross-site "simple" requests) | `src/index.ts` `readBody` parses any body with `req.json()` whatever its content type, and nothing checks `Origin`/`Sec-Fetch-Site`. Local repro: `POST /v2/setups` with `content-type: text/plain`, `Origin: https://evil.example`, `Sec-Fetch-Site: cross-site` returned **200** and created a setup. | Fixed |
| F2 | **Medium** | Shared free daily budgets can be drained by many IPs, or by one script staying within its limits | Limits are per IPv4 address or IPv6 /64 only (`src/limits.ts`; `src/index.ts` notes "no Turnstile gate"). One IPv6 /48 holds 65,536 /64s. The AI neurons, browser minutes, queue operations and 100k requests per day are shared by all users, so draining them is a denial of service for everyone. Worst case: one script within its 20/minute limit could make 28,800 page reads a day, about 70,000 D1 writes, close to the 100k free writes. Once D1 writes run out, every request fails. | Fixed (approved 2026-10-19), except raw request floods ([below](#f2-what-was-implemented-approved-2026-10-19)) |
| F3 | Low | No request body size limit | `readBody` reads the whole body before validating. Local repro: a 3 MB JSON body was fully parsed, then rejected with 400 "url is required". Bounded only by platform limits (10 ms CPU, 128 MB). | Fixed |
| F4 | Low | API responses carry no security headers | Live: `GET /v2/nothing` returns only `Content-Type`. `public/_headers` covers static files only. `/run/{id}` returns third-party page text as `text/plain` without `nosniff`. | Fixed |
| F5 | Low | Anyone holding a setup's run link can delete it | `src/index.ts` `DELETE /v2/setups/{id}` has no ownership check, and the ID is the same one in the shareable `/run/{id}` link. Local repro: DELETE returned 200, then run returned 404. IDs can't be guessed or enumerated, and setups hold only an address and settings. | Needs your approval (schema change) |
| F6 | Low | Upstream error details are returned to callers | `src/scrape.ts` `render()` appends Browser Run's error codes and messages (for example authentication errors) to `SCRAPE_FAILED`. `src/json.ts` returns raw model error text. This exposes operator configuration state, but no secret values. | Fixed |
| F7 | Low | Status polls and deletes aren't rate limited | `src/index.ts`: `GET /v2/crawl/{id}` (commented as a shortcut) and `DELETE`. Each is a cheap D1 call, but every request, including 404s, counts against the shared 100k requests per day. Per-IP limits on every route would need a WAF rule (custom domain only) or more D1 writes. | Documented |
| F8 | Low (potential) | DNS rebinding window in the SSRF guard | `src/guard.ts:47` (acknowledged in code): the DoH check and `fetch()` resolve separately. Workers' outbound network should not reach private ranges, which limits the impact; **this was not verified here**. Redirect hops are re-checked. | Documented |
| F9 | Low (potential) | JavaScript-rendered pages can navigate without re-checks | `src/scrape.ts` `render()` checks only the starting URL. In Cloudflare's browser, script redirects and subresources aren't re-checked against robots.txt or the SSRF guard. The browser runs on Cloudflare's network, not this app's. **Not verified**. | Documented |
| F10 | Low | Vulnerable packages in the dev toolchain only | `npm audit`: 5 high (sharp, undici via miniflare in wrangler and @cloudflare/vitest-pool-workers). Runtime dependencies: **0**. These packages aren't deployed, and npm's suggested "fix" is a downgrade. | Tracked by Dependabot |
| F11 | Info | Prompt injection into fact extraction | `src/json.ts`: untrusted page text goes to the model. Existing mitigations: hidden text stripped, the system prompt says to ignore page instructions, JSON schema output, no tools, no secrets, and results go only to the requester. A page can influence only the facts reported about itself. | Accepted |
| F12 | Info | O(n²) regex passes on pathological HTML | `src/scrape.ts:58-59` (acknowledged in code). Bounded by the 5 MB cap and the CPU limit; only that one request fails. | Accepted |
| F13 | Info | `GET /run/{id}` has side effects | It runs a scrape and updates `last_run`, so link prefetchers or `<img>` tags on other sites can trigger runs. They're rate limited per visitor; GET is needed for one-click links and `irm <link>`. | Accepted |
| F14 | Info | Static page lacks COOP and Permissions-Policy | Lighthouse "origin isolation with COOP" (unscored); `public/_headers`. | Fixed |
| F15 | Info | No CI security checks | No `.github/` directory: no secret scanning, code scanning, dependency review or automated updates. | Fixed |

**Checked and found sound (no finding):**
- All D1 queries are parameterised. The one template string, in the cron, uses constant table names.
- SSRF guard: http/https only, ports 80/443, no credentials, no IP literals, no single-label or local suffixes, no self-host. Every DoH A/AAAA answer must be public, every redirect hop is re-validated, with a 5 MB cap and a 15 s timeout.
- robots.txt is checked on every hop.
- Rate limits fail closed if D1 errors.
- Secrets are only Worker secrets. `.dev.vars` is git-ignored. A full-history pattern scan found only the documented `fc-keyless` placeholder (a false positive).
- The web page inserts API data with `textContent` only, under a strict CSP with no inline scripts or styles and `connect-src 'self'`.
- 500 errors are generic.
- Input limits: formats, schema at most 10,000 characters, prompt at most 2,000, limit ≤ 100, depth ≤ 3, at most 20 fact fields.
- The `DISABLED` kill switch also stops queued work.

## What was changed, and why

| File | Change | Finding |
|---|---|---|
| `src/index.ts` | POST/DELETE refused with `403 CROSS_SITE_BLOCKED` when the browser marks them cross-site (`Sec-Fetch-Site`) or from another `Origin`, checked before rate limiting so refused requests cost nothing. GET (run links) is not affected. | F1 |
| `src/index.ts`, `src/guard.ts` | Request bodies capped at 64 KB (`413 PAYLOAD_TOO_LARGE`): declared lengths are refused before reading, and other bodies are capped while streaming. The capped reader (`readCapped`) is now shared with the existing 5 MB page cap. | F3 |
| `src/index.ts` | Every Worker response gets `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: no-store`. | F4 |
| `src/scrape.ts`, `src/json.ts` | Browser Run and Workers AI error details go to the Worker logs; callers get a generic message (HTTP status kept). | F6 |
| `public/_headers` | Added COOP, COEP (`require-corp`), CORP, Permissions-Policy, X-Frame-Options and HSTS (no `includeSubDomains`). The page is now cross-origin isolated; the CSP is unchanged. | F14, ZAP 90004 |
| `test/security.test.ts` (new) | 7 regression tests through the real Worker: cross-site refusal (4 browser header variants, 3 endpoints, DELETE, nothing counted), the page and non-browser clients still accepted, run links from other sites still work, 413 for declared and streamed bodies, security headers on every response, model errors not leaked. | F1, F3, F4, F6 |
| `vitest.config.ts`, `wrangler.ci.toml` (new) | Tests run one file at a time (parallel runtimes hung on Windows). `CRAWLER_WRANGLER_CONFIG` selects a never-deployed copy of the config without the Workers AI binding, so tests and `wrangler dev` run with no Cloudflare login. | CI |
| `.github/workflows/security.yml` (new) | Typecheck and tests; Gitleaks over the full history (official image pinned by digest); `npm audit` that fails on any advisory in deployed dependencies and reports dev-tool advisories; a rebuild check that committed `public/` bundles match `ui/` sources; dependency review on PRs. | F10, F15 |
| `.github/workflows/codeql.yml`, `.github/codeql/codeql-config.yml` (new) | CodeQL `security-extended` for JavaScript/TypeScript; built bundles excluded (their sources are scanned, and the rebuild check proves they match). | F15 |
| `.github/workflows/zap.yml`, `.zap/rules.tsv` (new) | OWASP ZAP baseline against a throwaway local instance in the runner; fails on any new warning; two accepted alerts with written reasons. | F15 |
| `.github/dependabot.yml` (new) | Weekly npm and GitHub Actions update PRs (dev tooling grouped). | F10, F15 |
| `.gitleaks.toml` (new) | Default rules plus allowances for the documented `fc-keyless` placeholder and for directories that are never committed. | F15 |
| `SECURITY.md` (new), `README.md` | Private reporting process, scope, and rules for testing safely; README notes the two new error codes and the CI checks. | — |
| `.gitignore` | Ignore `.claude/` (local tool settings). | — |

Every GitHub Action is pinned to a full commit SHA, and each container image to a sha256 digest, all from releases at least two weeks old.

## Commands run and results

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **Passed** |
| Tests (with Cloudflare login) | `npx vitest run` | **Passed**: 27/27 (11 existing, 7 security, 9 limits for F2) |
| Tests (no credentials, as CI runs them) | `CRAWLER_WRANGLER_CONFIG=./wrangler.ci.toml npx vitest run` with an empty Wrangler config dir | **Passed**: 27/27 |
| Secrets, git history | Gitleaks v8.30.1 (`gitleaks git`, container pinned by digest) | **Passed**: 17 commits, no leaks |
| Secrets, working tree | Gitleaks `dir` | 33 findings, **all in `_ref/`** (git-ignored third-party clones, placeholder keys in their `.env.example` files); now allow-listed. 0 in this project's files. |
| Secrets, files changed after that run | Pattern scan (keyword plus token, private keys, GitHub/AWS keys, 32-hex IDs) over 45 new or changed files | **Passed**: 0 matches |
| Deployed dependencies | `npm audit --omit=dev` | **Passed**: 0 vulnerabilities |
| All dependencies | `npm audit` | **5 high, dev tools only** (sharp, undici via miniflare in wrangler); no upstream fix yet (F10) |
| DAST | ZAP baseline (`zap-baseline.py`, stable image pinned by digest) against `wrangler dev -c wrangler.ci.toml` on 127.0.0.1 | Before fixes: 0 fail, 3 warn. **After: 0 fail, 0 warn, 65 pass, 2 ignored with reasons** |
| The web page after hardening | Headless Chrome against the hardened local server | **Passed**: WebGL hero, fonts, zero console errors; whole-website read of example.com through the UI ("Done: 1 page."); save → Run → Remove (POST and DELETE both 200); `crossOriginIsolated === true` |
| Workflow files | Local lint: no tabs, even indentation, every `uses:` pinned to a SHA, every image to a digest | **Passed**; full schema validation happens on GitHub at the first push |
| CodeQL, Dependabot, dependency review | — | **Not run** (they run on GitHub after the push) |
| Gitleaks re-run after the last doc edits | — | **Not run**: Docker stopped. The pattern scan above covered those files. |
| Production | — | **Not scanned** (by design). The security changes are **not deployed yet** |

## F2: what was implemented (approved 2026-10-19)

| Budget (free per day) | Before | Now |
|---|---|---|
| D1 rows written: 100,000 | Each page read costs about 2–5 rows; each refused request also cost 1 row; no daily cap per connection | **1,000 page reads per connection per 24 h** (on top of 20 a minute); **15,000 page reads a day for everyone** (`503 DAILY_BUDGET_EXHAUSTED` until 00:00 UTC); refused requests write **0 rows**, measured with D1's own `rows_written` (a new counter writes 2, a counted request 1, a refusal 0), and refusals already seen in an isolate skip D1 entirely |
| Queue operations: 10,000 | 7 IPs × 5 crawls × 100 pages filled it | **2,500 crawled pages a day for everyone**, charged as pages are queued (a 1-page crawl costs 1). New crawls are refused with 503 once it's used up; running crawls stop adding pages. **10 crawls a day per network** (IPv4 /24 or IPv6 /48) |
| Workers AI: 10,000 units | 17–40 units per fresh look-up (about 250–580 a day); 13–29 IPs, or one IPv6 /48, drained it | **60 fact look-ups a day per network** (IPv4 /24 or IPv6 /48), on top of 20 per connection |
| Worker requests: 100,000 | Every call counts, including refused ones | **Unchanged; this can't be fixed in code on the free plan** (see below) |

Code:
- `src/limits.ts`: `subnetKey`, conditional upserts, `spendShared`/`sharedLeft`/`addShared`, and per-isolate memory of refusals.
- `src/index.ts`: `pageRead` and the crawl route.
- `src/crawl.ts`: `claim` charges the shared crawl budget.
- `src/scrape.ts`: the network limit on fact look-ups.

No schema change: the existing `counters` table holds the new keys, and the hourly cron already deletes expired rows. Tests: `test/limits.test.ts` (9 tests).

**Still open (needs money or infrastructure, so your call):** a raw flood of requests, about 1.2 per second sustained for a day from any single client, uses up the 100,000 Worker requests even when every request is refused. Only edge rate limiting stops that. The options are a custom domain with Cloudflare's free rate-limiting rule (about $10 a year for the domain; the free rule only blocks for 10 s at a time) or Workers Paid ($5 a month, no daily request cap, usage billing). Turnstile wasn't used: API clients can't solve it, and an attacker would call the API directly.

## Remaining findings that need your decision

1. **F2, raw request floods:** a custom domain with a rate-limiting rule, or Workers Paid; see above. The rest of F2 is fixed.
2. **F5: a delete key for saved setups.** Return a separate secret at creation, store only its hash in a new `setups` column, and require it on DELETE; existing setups would stay deletable by ID until they expire. This is a schema change.
3. **GitHub repository settings** (I can't change these from here, and they need your OK in any case):
   - Settings → Code security: turn on **Private vulnerability reporting** (SECURITY.md points to it), **Dependabot alerts**, **Dependabot security updates**, and **Secret scanning** with **Push protection**.
   - Code scanning results appear after the first CodeQL run.

## Deploying and rolling back

Production currently runs the redesigned page (version `494728e6-fffe-47dc-9319-7e9257dff71d`) **without** these security changes.

Deploy (after review): `npx wrangler deploy`. Then check:
- `curl -sI https://crawler-free.crawler-free.workers.dev/v2/x` shows `x-content-type-options: nosniff`.
- A cross-site POST is refused: `curl -s -X POST https://crawler-free.crawler-free.workers.dev/v2/setups -H "Sec-Fetch-Site: cross-site" -d "{}"` returns `CROSS_SITE_BLOCKED`.
- The page still reads a URL.

Roll back the Worker and static files together:
- To the redesign without the security changes: `npx wrangler rollback 494728e6-fffe-47dc-9319-7e9257dff71d`.
- To the page before the redesign: `npx wrangler rollback eda6afa7-002b-455e-a6e9-054356c918a6`.
- Or `git revert` the commit and deploy again.

No D1 schema, secrets or Cloudflare settings change in this work, so a rollback needs nothing else.

## Limits of this audit

- Automated checks and a code review cannot show the service is secure; they reduce known classes of risk.
- F8 (DNS rebinding) and F9 (navigation inside Browser Run) are untested assumptions about Cloudflare's network.
- The public instance was only touched with harmless requests: a 404, header reads and an OPTIONS preflight. No load or attack testing was run against it.
