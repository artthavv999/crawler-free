# Crawler Free CLI: Phase 1 audit and plan

Phase 1 of `crawler_free_hybrid_cli_plan.md`: inspect, document, measure, propose. **No production code was changed.**
Repository state: `main` at `5483281`, identical to GitHub; the other remote branches are Dependabot update PRs.

## 1. Baseline checks (2026-10-19, Node 26.1.0, npm 11.17.0)

| Check | Command (from `package.json`) | Result |
|---|---|---|
| Clean install | `npm ci` | Passed (94 packages) |
| Typecheck | `npm run typecheck` | Passed |
| Tests | `npm test` | Passed: 32/32 |
| Web page build | `npm run build:ui` | Passed; output identical to the committed `public/` |
| Deployed dependencies | `npm audit --omit=dev` | 0 vulnerabilities |
| All dependencies | `npm audit` | 5 high, all in dev tools (sharp, undici via wrangler), already tracked |

There is no `lint` script.

## 2. API contract the CLI will use

Base URL: `https://crawler-free.crawler-free.workers.dev`. No key, no sign-up. Requests from a CLI carry no browser
headers, so the cross-site check (`CROSS_SITE_BLOCKED`) never applies to it. Request bodies are limited to 64 KB, far
above anything the CLI sends.

| Call | Request | Success response |
|---|---|---|
| `POST /v2/scrape` | `{ url, formats }`; formats: `"markdown"`, `"links"`, `{ type: "json", schema, prompt? }` | `{ success: true, data: { markdown?, links?, json?, warning?, metadata } }` + `x-cache: HIT\|MISS`. `metadata` has `title, description, language, sourceURL, url, statusCode, proxyUsed`, plus `og*` fields when present |
| `POST /v2/crawl` | `{ url, limit (1–100, default 10), maxDiscoveryDepth (0–3, default 2), scrapeOptions: { formats } }` (markdown/links only) | `{ success: true, id, url, warning? }`, where `url` is the status URL |
| `GET /v2/crawl/{id}?skip=N` | — | `{ success, status: "scraping"\|"completed", completed, total, creditsUsed: 0, expiresAt, next, data[] }`, 10 pages per response, follow `next` (an absolute URL) until it is `null` |
| `POST /v2/setups`, `GET /run/{id}`, `DELETE /v2/setups/{id}` | saved setups | Not needed for the first CLI version |

Facts are a JSON schema that the CLI builds from field names, exactly like the web page does:
`{ type: "object", properties: { <field>: { type: "string" } } }`. Spaces in field names become `_`.

**Crawl status, two gaps that matter for the CLI:**
- **Failed pages are invisible.** `data[]` lists only finished pages, and `total` counts pages that haven't failed. A page that fails (blocked, timeout, too large) appears nowhere, so the CLI can't report partial failures. See decision D5.
- `expiresAt`: results are deleted 24 h after the crawl started, so the CLI must fetch everything as soon as the job completes.

**Errors:** always `{ success: false, code, error }`, where `error` is a plain-English sentence meant for the user.

| HTTP | Codes | CLI behaviour |
|---|---|---|
| 400 | `BAD_REQUEST`, `URL_BLOCKED` | Exit 2 (bad input) or 3 (refused); show `error` |
| 403 | `ROBOTS_DISALLOWED`, `BLOCKED` | Exit 3; no retry, ever |
| 404 | `NOT_FOUND` | Exit 1 (e.g. a crawl older than 24 h) |
| 408 | `SCRAPE_TIMEOUT` | Exit 5 |
| 429 | `RATE_LIMITED` (+ `Retry-After`) | Exit 4 and say when to try again; poll requests wait and retry within the overall timeout |
| 503 | `DAILY_BUDGET_EXHAUSTED` (+ `Retry-After`), `EXTRACT_BUDGET_EXHAUSTED`, `RENDER_BUDGET_EXHAUSTED`, `RENDER_BUSY` (+ `Retry-After: 10`), `DISABLED` | Exit 4 (quota or busy) or 1; explain it's a shared free service |
| 500 | `SCRAPE_FAILED`, `EXTRACT_FAILED`, `UNKNOWN_ERROR` | Exit 1 |

**Limits a CLI user will meet** (per connection = one IPv4 address or IPv6 /64; per network = IPv4 /24 or IPv6 /48):

| What | Limit |
|---|---|
| Page reads (scrape) | 20/minute and 1,000/day per connection; 15,000/day for everyone |
| Fact look-ups | 20/day per connection, 60/day per network, plus the shared AI budget |
| Whole-website reads | 5/day per connection, 10/day per network, 100 pages each; 2,500 crawled pages/day for everyone |
| Crawl status polls | 60/minute and 2,000/day per connection |

## 3. Decisions for you (my recommendation first)

- **D1. Package name `crawler-free`.** It's free on npm today, as are `crawlerfree`, `crawler-free-cli`, `crawlfree` and `free-crawler`. Re-check right before publishing, which needs your npm login and your approval (Phase 6). The command is `crawler-free`.
- **D2. Runtime: Node.js 22 or newer, and zero runtime dependencies.** Node 20 reached end of life on 2026-04-30. Built-in `fetch`, `util.parseArgs`, `fs` and `readline` cover everything, so the published package has no third-party code to audit.
- **D3. Layout.** `cli/src/*.ts` and `cli/test/*.test.ts`, plus a separate `cli/package.json` (name, `bin`, `engines`, `files`) so the Worker's dependencies stay untouched. The CLI is bundled by esbuild (already a dev dependency) into `cli/dist/crawler-free.mjs`. Root scripts: `build:cli`, `test:cli`. Tests run with the existing vitest in a separate Node config (`cli/vitest.config.ts`), and the Worker test setup stays as it is. CI gets a CLI job. No new dependencies.
- **D4. Formats: `markdown` (default), `links`, `json`.** `json` is the full API response for the page, metadata included. The API has no plain-text format, so I'd **leave `--format text` out** rather than invent one in the CLI. Alternative: a clearly labelled local Markdown-to-text conversion.
- **D5. Partial crawl failures need a small backend addition.** Add a `failed` count, and a list of failed URLs with their error codes, to `GET /v2/crawl/{id}`. It's additive, so the Firecrawl SDK is unaffected, but it is a backend change and a deploy. Without it the CLI can only say "N pages saved", never "3 failed".
- **D6. `doctor` without a new endpoint and without using quota.**
  - `GET /` (a static file, free and unlimited) checks connectivity and TLS.
  - A status poll for an all-zero job ID must return `404 NOT_FOUND` as JSON. That proves the API is answering, and costs one of 60 polls a minute.
  - Alternative: add `GET /v2/health` (a backend change).
- **D7. Where results go.**
  - **Scrape:** `./crawler-free-output/<host>_<path>.md`. The name is sanitized from the URL, never from page content.
  - **Crawl:** a folder `./crawler-free-output/<host>-crawl/` with one `.md` per page plus `pages.json`, which maps each URL to its file and title.
  - **Overwriting:** never silent. Interactive runs ask; non-interactive runs fail unless `--force` is given.
  - **Scripts:** `--stdout` writes data to stdout, and progress always goes to stderr.
- **D8. Config.** One small JSON file holding only `apiUrl` and the mode:
  - **Windows:** `%APPDATA%\crawler-free\config.json`
  - **macOS:** `~/Library/Application Support/crawler-free/config.json`
  - **Linux:** `$XDG_CONFIG_HOME/crawler-free/config.json`

  `crawler-free setup` writes it (hosted is the default), and `crawler-free setup --reset` deletes it. The CLI works with no config at all.
- **D9. Polling and retries.**
  - **Crawl polls:** every 3 s, backing off to 15 s, always honouring `Retry-After`. Overall timeout 30 min by default (`--timeout`): 100 pages at a site's maximum 10 s crawl delay take about 17 min.
  - **POST requests (scrape, extract, crawl start) are never retried automatically,** so nothing repeats a paid-for or quota-using action. The message says when to try again.
  - **Network errors on polls:** up to 3 retries with backoff.
- **D10. Exit codes.**

  | Code | Meaning |
  |---|---|
  | 0 | Success |
  | 1 | Service error |
  | 2 | Usage error (bad arguments or input) |
  | 3 | Refused (blocked URL, robots.txt or the site said no) |
  | 4 | Limit, quota or busy |
  | 5 | Network or timeout |
  | 6 | Output file problem (exists or not writable) |

**Out of scope for the first version:** saved setups (`run <link>`), standalone binaries (Phase 7), and any local fetching. The CLI never fetches target sites itself: every page goes through the hosted API's SSRF guard, robots.txt checks and limits.

Note for the docs: GUIDE.md's `irm <run link>` only downloads the answer as text; it never runs a script (no `iex`).
That's consistent with the plan's rule against `curl | bash` / `irm | iex` installers.

## 4. Phases (each stops for your approval)

| Phase | Delivers | Touches production? |
|---|---|---|
| 2 | `cli/` skeleton, API client (timeouts, typed errors, D10 exit codes), `--help`, `--version`, `doctor`, config read/write, CLI CI job, tests | No |
| 3 | `scrape` (markdown/links/json, `--output`, `--stdout`, `--quiet`, `--json`, overwrite protection) + mocked-API tests | No |
| 4 | `crawl` (bounded polling, all pages, folder output), plus the D5 backend change if you approve it | Only with D5 (needs a deploy) |
| 5 | `extract --fields`, guided `setup`, quota explanations | No |
| 6 | README/GUIDE CLI sections, `npm pack` inspection, clean-install test; publish **only on your approval** | Publish = yes |
| 7 | Standalone binaries with checksums | Release = yes |

## 5. Phase 2 result: CLI foundation (2026-10-19, not committed)

**What exists now:** `crawler-free --help`, `--version` and `doctor`. `scrape`, `crawl`, `extract` and `setup` answer
"isn't available in this preview yet" (exit 2). The package is `"private": true`, so `npm publish` refuses it until Phase 6.

| Files | What |
|---|---|
| `cli/src/main.ts`, `bin.ts`, `args.ts`, `ui.ts` | Entry point, options (`--api-url`, `--timeout`, `--json`, `--quiet`, `--help`, `--version`), stdout/stderr split; stack traces only with `CRAWLER_FREE_DEBUG=1` |
| `cli/src/client.ts`, `errors.ts` | API client: timeout, 32 MB answer cap, user agent `crawler-free-cli/<version>`, no browser headers; every API error code mapped to the D10 exit codes, keeping the API's message and `Retry-After` |
| `cli/src/config.ts` | Settings path per OS (D8), read/write/reset, address checks (http(s) only, no credentials, query or fragment). The address comes from `--api-url`, then `CRAWLER_FREE_API_URL`, then the settings file, then the hosted service |
| `cli/src/doctor.ts` | Node.js ≥ 22, settings file, connection (`GET /`), API answering (status check of a job that doesn't exist → `NOT_FOUND`), results folder writable; text or `--json` |
| `cli/src/node.d.ts` | Narrow types for the few Node built-ins used, instead of adding `@types/node` (keeps D3's "no new dependencies") |
| `cli/test/*` | 25 tests with a local mock API (Node `http`): arguments, every error code's exit code, settings precedence and broken files, timeouts, unreachable servers, non-JSON/truncated/oversized answers, no browser headers sent, `doctor` (healthy, rate limited, wrong service, unreachable, old Node, broken settings, unwritable folder), help/version/unknown commands, stack traces hidden |
| `cli/package.json`, `tsconfig.json`, `vitest.config.ts`, `build.mjs` | Separate package, `bin`, `engines: >=22`, `files: [dist/crawler-free.mjs]`; esbuild bundle with a `#!` line |
| Root `package.json` | Added scripts `typecheck:cli`, `test:cli`, `build:cli`; no dependency changes |
| `.gitignore` | `cli/dist/` |
| `.github/workflows/security.yml` | New job "CLI on Node 22 / 24": typecheck, tests, build, run the built command, check that `npm pack` holds only `dist/crawler-free.mjs` and `package.json` |

**Checks run (Windows 11, Node 26.1.0):** `npm run typecheck` passed; `npm test` 32/32; `npm run typecheck:cli` passed;
`npm run test:cli` 25/25; `npm run build:cli` passed (17.9 KB, one file); the built command's `--version`, help and
a later-phase command give exit codes 0, 2 and 2; `npm pack --dry-run` lists 2 files (6.4 kB); `npm run build:ui`
reproduces `public/` exactly; `npm audit --omit=dev` found 0 vulnerabilities. Live `doctor` against the hosted service
passed all five checks in Git Bash and in PowerShell (`--json` parsed by `ConvertFrom-Json`); `--api-url ftp://…` failed
with exit 2.

**Not run yet:** the new CI job (it runs on GitHub after a push), and real macOS/Linux shells (CI covers Linux). The CLI
tests run with vitest but aren't typechecked by `tsc`: the narrow Node types cover the CLI source, not the test helpers.

**Trade-offs and risks:**
- `doctor`'s API check uses one of your 60 status checks a minute.
- The settings reset is "delete the file" until `setup --reset` arrives in Phase 5. The error message gives the exact path.
- The npm package has no README or LICENSE yet (Phase 6).
- The hand-written Node types must be extended when a phase uses another built-in.

## 6. Phase 3 result: `scrape` (2026-10-19, not committed)

`crawler-free scrape <url> [-f markdown|links|json] [-o <file or folder/>] [--stdout] [--force] [--json] [-q]`

- **Default:** saves to `./crawler-free-output/<host>_<path>.md` and prints the path, the size and the page title. `links` saves one link per line (`.txt`); `json` saves the whole answer for the page (text, links, metadata).
- **File names** come only from the address you asked for, never from page content. Only `a-z 0-9 . _ -` are kept, with no `..`, slashes or trailing dots, and the host always comes first, so a name can't be a Windows device name. A query string adds a short hash. Names are capped at 120 characters.
- **Never overwrites silently.**
  - The check happens *before* the page is read, so a refusal uses no quota.
  - At a terminal you're asked `Replace it? [y/N]`. In scripts and with `--json` the command stops with exit 6 unless `--force` is given.
  - Writes use exclusive create, which also catches a file that appears during the read.
- **For scripts:** `--stdout` prints the data only, with progress on stderr. `--json` prints a summary (`savedTo`, `characters`/`links`, `cached`, `title`, `warning`), or the error as JSON. `-q` prints just the saved path. `--stdout` with `--json` or with `--output` is a usage error.
- **Address check before any request:** a bare `example.com` becomes `https://example.com`; other schemes, credentials in the address, several addresses or an unknown format give exit 2. Whether a page may be read (private address, robots.txt) is still the service's decision, which comes back as exit 3 with a specific explanation.
- **Never retried automatically.** Limits show the service's message (for example "Try again in 30 seconds"), and `--json` includes `retryAfterSeconds`.

| Files | Change |
|---|---|
| `cli/src/scrape.ts` (new) | The command |
| `cli/src/output.ts` (new) | File names, target path (`--output` as a file, an existing folder or `folder/`), replace check, exclusive-create save |
| `cli/src/args.ts` | `--format/-f`, `--output/-o`, `--stdout`, `--force`; options for the wrong command are refused |
| `cli/src/client.ts` | Returns headers too (for `x-cache`) |
| `cli/src/errors.ts` | A specific explanation for each kind of refusal |
| `cli/src/main.ts`, `bin.ts`, `node.d.ts` | Dispatch and help; the question is asked only when stdin and stderr are terminals; `stat`, `readline` and `sep` types |
| `cli/test/scrape.test.ts` (new) | 13 tests, all against the mock API: save, bare host, links/json, `--stdout`, `--json`/`-q`, overwrite (script, no, yes, `--json`, `--force`; no request made when refusing), `--output` forms, unwritable target, service refusal (exit 3) and limit (exit 4, single request, no retry), local checks before any request, warnings/empty page/cache/broken answer, `CRAWLER_FREE_API_URL`, file names from hostile addresses, and a check that the CLI source never runs shell commands or `eval` |

**Checks run:** `npm run typecheck` passed; `npm test` 32/32; `npm run typecheck:cli` passed; `npm run test:cli` 38/38;
`npm run build:cli` passed (27.7 KB); `npm run build:ui` reproduces `public/`; `npm audit --omit=dev` found 0 vulnerabilities;
`npm pack --dry-run` lists `dist/crawler-free.mjs` and `package.json`.

**Live against the hosted service** (Git Bash and PowerShell 5.1, in a scratch folder):
- A Markdown save, and a links `--json` summary.
- `--stdout` piped.
- Overwrite refused from a script: exit 6, before any read.
- `http://127.0.0.1/` refused by the service: exit 3.
- A page with "£" was correct both saved and piped in PowerShell.

**Found and fixed during this phase:**
- File names turned the international-domain prefix `xn--` into `xn-`.
- Refusing to overwrite used to happen after the page was already read.
- A blocked private address was shown the robots.txt explanation.

**Not verified:** the real terminal prompt. Tests inject the question; `bin.ts`'s readline path needs a person at a terminal. macOS shells aren't covered either (CI covers Linux).

**Risks:** two different addresses can map to the same file name (for example `/a/b` and `/a_b`); the overwrite protection catches it rather than replacing silently.

## 7. Phase 4 result: `crawl` and D5 (2026-10-19, not committed, backend not deployed)

`crawler-free crawl <url> [--limit 1-100] [--depth 0-3] [--max-wait <minutes>] [-o <folder>] [--force] [--json] [-q]`

**Backend (D5).** `GET /v2/crawl/{id}` gains two fields:
- `failed`: the number of pages that couldn't be read, on every response.
- `failures`: `[{ url, code, error }]` (up to 100). It appears only once the crawl is completed, and only on the first results page (`skip=0`), so following `next` doesn't repeat it.

Nothing else changes: `total` still leaves failed pages out, Firecrawl's fields keep their order (`failed` comes after `total`, `failures` last), and there's no schema change or new query on unfinished jobs beyond one more `SUM`. The Firecrawl SDK ignores unknown fields.

**The command:**
- **Before anything starts:** it checks the options and the address, then the results folder (default `./crawler-free-output/<host>-crawl/`). A folder that already has files is used only with `--force` or a "yes" at a terminal. Refusing costs no quota, and nothing is ever deleted.
- **Waiting (D9):**
  - It checks after 3 s, and slows by half again each time nothing changes, up to 15 s. It goes back to 3 s when something changes.
  - `Retry-After` on a 429 is honoured. A dropped connection is retried 3 times, waiting longer each time.
  - `--max-wait` (default 30 minutes) bounds the whole wait. When it's reached, what's finished is saved, the exit is 5, and the message names the status address and when the results expire.
- **Results:** it follows `next` (refusing a link to any other server, and stopping after 20 pages of results). It saves one `.md` file per page, named only from the page's address, with clashes numbered `-2`, `-3`, and an unusable address saved as `page-N.md`.
- **`pages.json`** records the start, job ID, limit, depth, whether the crawl finished, the expiry, and each page's address, title, file and size. It also lists `failed` and `failures`. On a server without D5, `failed` is `null` and the output says failures can't be reported.
- **Exit codes:**
  - 0 when the crawl finished, even with some failed pages, which are listed.
  - 1 when every page failed.
  - 3 or 4 when the start was refused or limited.
  - 5 for a timeout or the network.
  - 6 for a folder problem.
- **`--json`** prints `{ ok, command, url, jobId, finished, folder, pages, failed, failures, expiresAt }`. `-q` prints only the folder.

| Files | Change |
|---|---|
| `src/crawl.ts` | D5: `failed` and `failures` in `crawlStatus` |
| `test/crawl-status.test.ts` (new) | 4 tests: counting while running, the list only when completed and on `skip=0`, field order over HTTP, no failures |
| `cli/src/crawl.ts` (new) | The command, with an injectable clock so tests never really wait |
| `cli/src/output.ts` | `hostSlug`, and `mayUseFolder` (the folder check) |
| `cli/src/args.ts` | `--limit`, `--depth`, `--max-wait`; each command refuses the other's options |
| `cli/src/main.ts` | Dispatch and help |
| `cli/test/crawl.test.ts` (new) | 14 tests against a scripted mock API (below) |

The 14 tests cover:
- the full flow, including the waits, `next`, files, `pages.json` and output
- `--limit`/`--depth`/`--output` and the 15 s cap
- `Retry-After` and a dropped connection
- giving up after 3 retries
- `--max-wait` with a partial save
- a refused or limited start
- the folder check (script, no, `--json`, yes, `--force`, a file in the way)
- links to another server
- a job that disappeared and an unknown status
- every page failing
- an older server
- hostile addresses in file names
- `--json` and `-q`
- option checks

**Checks run:**
- `npm run typecheck` passed; `npm test` 36/36.
- `npm run typecheck:cli` passed; `npm run test:cli` 52/52.
- `npm run build:cli` passed (39.4 KB).
- `npm run build:ui` reproduces `public/`.
- `npm audit --omit=dev` found 0 vulnerabilities.
- `npm pack --dry-run` lists `dist/crawler-free.mjs` and `package.json`.

**End to end against a local Worker with D5** (`wrangler dev -c wrangler.ci.toml`, fresh local database, built CLI):
- `books.toscrape.com`, `--limit 5 --depth 1`: 5 pages saved in about 8 s, `failed: 0`.
- `the-internet.herokuapp.com`, `--limit 10 --depth 1`: 8 pages saved. `/basic_auth` and `/digest_auth` (HTTP 401) were reported as `BLOCKED` in the output, in `pages.json`, and in the raw status (`failed: 2`, `failures` present), with exit 0.

**Found and fixed during this phase:**
- The timeout message said "after 1 minutes".
- A missing address showed the `scrape` example as its hint.

**Not verified:**
- Against the hosted service. It doesn't have D5 until a deploy, so today the CLI would say the server "doesn't report pages that failed" (that path is tested with the mock).
- The real terminal prompt.
- A `--max-wait` timeout against a real Worker (only the mock; the minimum is 1 minute, and real crawls of this size finish sooner).

**Notes:**
- The full `npm audit` (dev tools included) reports high-severity advisories in `sharp` and `undici` via `wrangler`/`miniflare`/`@cloudflare/vitest-pool-workers`. These are local development and test tools only, unchanged in this phase; the suggested fix is a breaking downgrade, so it's left for a separate dependency update.
- The web page's crawl view still shows only `completed`/`total`; showing `failed` there is a possible follow-up.

## 8. Phase 5 result: `extract` and `setup` (2026-10-19, not committed; no backend change)

`crawler-free extract <url> --fields <a,b,...> [-o <file or folder/>] [--stdout] [--force] [--json] [-q]`

**`extract`:**
- **Field names** follow the service's rules for saved setups: trimmed, spaces become `_`, repeats dropped, 1 to 20 names of up to 60 characters. `--fields` can be given more than once.
- **The request** is `{ type: "json", schema }` with the same schema the service builds for a saved setup's facts. So the same page and fields within the hour come from the cache, and use no fact look-up.
- **Before the request:** the file check happens first, like `scrape`, so a refusal uses no quota. On the hosted service it explains the AI quota: 20 fresh look-ups a day per connection, cached answers free.
- **Never retried automatically.**
- **Output:**
  - **Saved file:** the facts exactly as returned, as `<page>.facts.json`. That name can't clash with `scrape -f json`'s `<page>.json`.
  - **Terminal:** each fact is shown, and empty ones are named ("Not found on the page, or the model couldn't tell"). Every run ends with a reminder that a small AI model can be wrong.
  - **For scripts:** `--stdout` prints the JSON; `--json` adds `facts`, `empty` and `cached`.
- **Exit codes:** a limit is exit 4, with a separate explanation for the per-connection limit and for the shared AI budget. `EXTRACT_FAILED` is exit 1.

**`setup`:**
- **What it asks:** at a terminal, it asks which service to use. Pressing Enter picks the hosted one. Choosing your own copy first explains that a deployed copy is needed, with a link to the README's self-hosting steps, then asks for its address (up to 3 tries, a bare host gets `https://`).
- **Without questions:** `--hosted`, `--api-url <address>` and `--reset` skip them. In a script, or with `--json`, it never asks and picks the hosted service.
- **Before saving:** it runs `doctor`'s connection and API checks. If they fail, nothing is saved unless `--force` is given or you answer yes at a terminal.
- **After saving:** it prints the settings file, how to change or reset it, and the hosted limits. It also warns when `CRAWLER_FREE_API_URL` overrides the saved choice. A broken settings file is replaced.
- **What it saves (D8 refined):**
  - The hosted choice is just `{ "mode": "hosted" }`, so it follows the address built into the CLI if the hosted service ever moves.
  - Your own copy is `{ "mode": "self-hosted", "apiUrl": ... }`.
  - Nothing else is ever stored: no keys, tokens or passwords.
  - A file that says hosted but names another address, or has an unknown mode, is reported as invalid.
- **`--reset`** removes the file, and its `crawler-free` folder if that's left empty.

**Also changed:**
- **Prompts:** pressing Ctrl+C at a question now stops the program (exit 130) without changing anything. End of input counts as an empty answer, which is always the safe default. Before, Ctrl+C could leave the program ending with exit 0.
- **Page text in the terminal:** titles and facts shown on screen have control characters, escape sequences and direction overrides removed (`printable`), so a page can't send escape sequences to your terminal. Saved files and `--stdout` keep the data exactly.
- **Error codes:** a separate hint for each limit code. Error codes are looked up with `Object.hasOwn`, so a code like `constructor` can't match an inherited property.
- **Help:** lists all five commands. The `scrape` hint no longer calls `crawl` "coming next".

| Files | Change |
|---|---|
| `cli/src/extract.ts`, `cli/src/setup.ts` (new) | The two commands |
| `cli/src/config.ts` | Settings file format above; reset removes the empty folder |
| `cli/src/doctor.ts` | `serviceChecks`, shared with `setup` |
| `cli/src/args.ts`, `main.ts` | `--fields` (repeatable), `--hosted`, `--reset`; dispatch; help |
| `cli/src/errors.ts`, `ui.ts`, `output.ts`, `scrape.ts`, `bin.ts`, `node.d.ts` | Limit hints, `printable`, `.facts.json` names, prompt handling, types |
| `cli/test/extract.test.ts` (new) | 11 tests |
| `cli/test/setup.test.ts` (new) | 10 tests |
| `cli/test/core.test.ts`, `commands.test.ts` | Settings format, reset, limit hints, `printable`; removed the "not available yet" check |

The 11 `extract` tests cover:
- the request and schema, the file and the output
- the hosted quota note
- field-name rules
- empty facts
- `--stdout`/`--json`/`-q`
- the cache note
- escape sequences in page text
- limits, failures and broken answers, each sent once
- overwrite protection before the request
- names that don't clash
- option checks

The 10 `setup` tests cover:
- a script with no options
- `--api-url`, then `doctor` using it, then `--reset`
- answers at a terminal: Enter, your own copy with a bad address first, and three unclear answers
- failed checks with no, yes and `--force`
- not a Crawler Free service, and unreachable
- `--json`/`-q`
- the `CRAWLER_FREE_API_URL` note, and replacing a broken file
- option checks

**Checks run:**
- `npm run typecheck` passed; `npm test` 36/36.
- `npm run typecheck:cli` passed; `npm run test:cli` 75/75.
- `npm run build:cli` passed (54.4 KB).
- `npm run build:ui` reproduces `public/`.
- `npm audit --omit=dev` found 0 vulnerabilities.
- `npm pack --dry-run` lists `dist/crawler-free.mjs` and `package.json`.
- `cli/src` has no shell commands or `eval`.

**Real runs with the built CLI** (settings in a scratch folder; the real `%APPDATA%\crawler-free` was never created):
- **Local Worker** (`wrangler dev -c wrangler.ci.toml`):
  - `setup --api-url` saved `self-hosted`.
  - `doctor` and `scrape` used it.
  - `extract` failed cleanly (exit 1), because that copy has no AI binding.
  - `setup --reset` removed the file and folder.
- **Hosted service:**
  - `setup --hosted` saved `{ "mode": "hosted" }`; its checks use no page-read or AI quota.
  - One `extract` of a books.toscrape.com page returned the right title, `£51.77` and availability in 3.6 s.
  - Repeating it in PowerShell with `--json` and with `--stdout` was answered from the cache (no look-up used), with "£" intact.

**Not verified:**
- **The real terminal prompt**, including Ctrl+C and end of input. Tests inject the answers, and there is no terminal to type into here.
- **Cache sharing with a saved setup's run.** It's by construction (same schema), not tested live.

**For Phase 6 docs:** `crawler-free setup` (choosing the service) and the web page's "saved setups" (one-click re-runs) share a word. The README and GUIDE should keep them clearly apart.

## 9. Phase 6 result: docs and the npm package (2026-10-20; published 0.1.0)

**Docs:**
- **README.md:** the top now answers the plan's five questions in order. It covers what Crawler Free is, the browser, the terminal (`npx crawler-free ...`, where results go, what to do when something fails), and your own code. The endpoint and limit reference below is unchanged.
- **GUIDE.md:** a new beginner section, "The quick terminal way", comes before the plain `curl`/`irm` steps, which stay. "If something goes wrong" now starts with `doctor` and the PowerShell script-policy workaround. It also says plainly that `crawler-free setup` is unrelated to the web page's saved setups.
- **cli/README.md (new):** the npm package page and the full CLI reference. It covers:
  - installing, and every command
  - where results go
  - scripting: `--json`, `--stdout`, `-q`, and the exit codes
  - limits, and the settings file locations
  - safety and privacy, and troubleshooting
  - uninstalling
- **SECURITY.md:** the CLI and its npm package are now in scope.

**Package:**
- **Name:** `crawler-free` is still free on npm (checked 2026-10-20, as are `crawlerfree` and `crawler-free-cli`).
- **Contents:** the tarball holds exactly `LICENSE`, `README.md`, `package.json` and `dist/crawler-free.mjs` (19.6 kB packed, 62.5 kB unpacked).
- **Scan:** no local paths, personal details or secrets.
- **Changes:** `cli/package.json` gained keywords, a homepage pointing at the CLI README, and `prepublishOnly: node build.mjs`, so a publish always ships a fresh build. `"private": true` stayed on as a safety latch until the publish.
- **CI:** the pack check now expects the four files, and a new step installs the packed tarball into a clean prefix on Linux (Node 22 and 24), runs it and uninstalls it.

**Clean install test on Windows** (separate npm cache and prefix, in a folder named `clean install ü`):
- `npm install --global` from the tarball worked (zero dependencies).
- The installed command ran from Git Bash, from cmd, and from PowerShell.
- With PowerShell scripts blocked (`-ExecutionPolicy Restricted` in a one-off process, as on a default Windows 11 machine), `crawler-free` failed with "running scripts is disabled" and `crawler-free.cmd` worked, as the docs say.
- From `work dir ñ`, `doctor` passed and `scrape https://example.com` saved `...\work dir ñ\crawler-free-output\example.com.md`.
- `npx --package <tarball> crawler-free --version` worked.
- `npm uninstall --global` removed the command.
- Settings were kept in a scratch folder; the real `%APPDATA%\crawler-free` was never created.

**Checks run:**
- `npm run typecheck` passed; `npm test` 36/36.
- `npm run typecheck:cli` passed; `npm run test:cli` 75/75.
- `npm run build:cli` passed.
- `npm run build:ui` reproduces `public/`.
- `npm audit --omit=dev` found 0 vulnerabilities.
- The workflow YAML wasn't parsed locally (no parser installed); GitHub checks it on push.

**Publish (2026-10-20): `crawler-free@0.1.0` published by `arthav.t` at 06:43 UTC.**
- **Staged first:** npm now stages a new package. Until processing finishes, the name shows a placeholder version `0.0.0-stage` ("Temporary package placeholder for staged publishing") owned by `arthav.t`. "Staged Packages" in the account settings showed nothing waiting for approval.
- **What it took:**
  1. An npm account with **2FA actually registered**. Choosing a mode isn't enough: npm answered `403 … Two-factor authentication … is required to publish` until a security key (Windows Hello) was added.
  2. A login via `npm login`. Its link lasts about two minutes, and npm also emails a one-time code, so the reliable way was to sign in to npmjs.com in the built-in browser first, then open the CLI link there.
  3. `npm publish --access public` in a Terminal panel tab. npm printed an "Authenticate your account at" link; it was opened in the built-in browser and approved with the security key.
- **Snags along the way:** npm 11.17 crashed (`Exit handler never called!`) whenever a login link expired and it fell back to a username prompt. Repeated attempts hit npm's "2FA attempts currently rate limited".
- **Docs:** README, GUIDE and `cli/README.md` are back to `npx crawler-free`, and README keeps a one-line from-source alternative. `"private": true` is gone from `cli/package.json`.
- **0.1.1, the same day:** 0.1.0 was published while `cli/README.md` still had its "Not on npm yet" note, and npm's package page shows the newest version's README. 0.1.1 changes only the README and the version number. The first approval link expired before it was used; a fresh `npm publish` and an immediate security-key approval worked.

Later, optionally: publishing from GitHub Actions with npm's trusted publishing would add provenance (a signed link from the package to this repository's source), and would avoid browser sign-ins for future releases. A local publish can't add that.

**Not verified:**
- macOS (Linux is covered by CI).
- The real interactive prompts (as in Phase 5).

## 10. Phase 7 result: standalone downloads (2026-10-20, not committed, nothing released)

**D11. Packaging: Node.js's own single executable applications** (`node --build-sea`, Node 25.5 or newer).
- **How it works:** the CLI, bundled as CommonJS, goes inside a copy of the official Node binary. No third-party code is added, which keeps D2's zero-dependency rule.
- **Alternatives not taken:**
  - `bun build --compile` or `deno compile` would ship a different runtime from the one the CLI is tested on.
  - `pkg` and `nexe` are third-party and no longer maintained.
- **Size:** about 100 MB per program, because Node is inside.

**Build:** `npm run build:cli-binary` (`cli/build-sea.mjs`) builds for the computer it runs on, into `cli/dist/sea/`. It writes:
- the program
- `LICENSE`
- `NODE-LICENSE.txt` (Node.js and the libraries inside it, which every copy must carry). It's taken from beside `node`, or, when the Windows installer left it out, from Node's repository for the same version.

It also signs the program ad hoc on macOS (macOS won't run unsigned programs), and checks that the built program reports the right version.

**`doctor`** says "Standalone build, with Node.js X built in" instead of checking the Node version (`node:sea`'s `isSea()`; one new test, 76/76).

**Release workflow** (`.github/workflows/cli-release.yml`):
- **Trigger:** a `cli-vX.Y.Z` tag that matches `cli/package.json`.
- **Build:** five runners: Linux x64 and ARM64, macOS Apple silicon and Intel, Windows x64. Each one runs `npm ci`, the CLI typecheck and tests, the build, and a check that the program runs and reports Node as built in. That check uses a closed local port, so nothing leaves the runner.
- **Package:** `.zip` for Windows, `.tar.gz` elsewhere.
- **Release:** `SHA256SUMS.txt`, GitHub build provenance (`actions/attest-build-provenance`), and a **draft** release made with the preinstalled `gh`. Nothing is public until you press Publish.
- **By hand:** "Run workflow" only builds, tests, and keeps the archives as artifacts for 7 days, which makes it a dry run.
- **Safety:**
  - Actions are pinned to commits at least 14 days old (download-artifact v8.0.1, not the 13-day-old v8.0.2).
  - No dependency cache in release builds.
  - Read-only by default; only the release job may write, sign provenance, and create the draft.

**Not signed with a paid certificate (your decision).** Windows SmartScreen and macOS Gatekeeper warn on first run. `cli/README.md` explains the warnings and how to check a download first (checksums, `gh attestation verify`). Removing the warnings needs a Windows code-signing certificate and an Apple Developer ID; both cost money every year.

| Files | Change |
|---|---|
| `cli/build-sea.mjs` (new), `package.json` | The build, and `build:cli-binary` |
| `.github/workflows/cli-release.yml` (new) | The release workflow above |
| `cli/src/bin.ts`, `main.ts`, `doctor.ts`, `node.d.ts`; `cli/test/commands.test.ts` | Standalone line in `doctor`, with a test |
| `cli/README.md`, `README.md`, `GUIDE.md` | Downloading, first-run warnings, verifying, uninstalling |

**Checks on Windows:**
- **The program:** built 99 MB. With **no Node.js on the PATH**:
  - `--version` printed `0.1.1`.
  - `doctor` passed all five checks.
  - `scrape https://example.com` saved the page.
  - An unknown option still exited with code 2.
  - No experimental-feature warning appeared.
- **Signature:** after the build it reads "NotSigned" (Node's own signature is removed cleanly, not left broken).
- **Workflow steps run locally:** the "runs on its own" check passes on the real program, and the release-notes step produces the right text (with `gh` replaced by `echo`).

**Dry run 1 (2026-10-20, run 39385421107, started by hand):**
- **Passed:** Linux x64 and ARM64. On each, the tests passed, the program was built, it ran with Node built in, and it was packaged, in about 30 s.
- **Failed:** macOS Apple silicon and Intel, in one CLI test. That test wrote its broken settings file to the Linux location, but on macOS the CLI correctly reads `~/Library/Application Support/crawler-free`.
- **Not reached:** Windows was stopped early because the macOS jobs had failed.
- **Fixed:** the test now asks `configPath` for the location. The regular CLI checks now also run on macOS (Node 24), so this is caught on every push.

**Not verified yet** (the first full workflow run will show these):
- The macOS and Linux builds, and the macOS ad-hoc signing.
- The workflow's YAML (no local parser; GitHub checks it on push).
- SmartScreen and Gatekeeper behaviour on a real download.
- `gh attestation verify`, which needs a first release.

The program's Windows file details still say "Node.js" (changing them needs another tool).
