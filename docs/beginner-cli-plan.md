# Beginner-friendly terminal use: audit check and plan

Response to `crawler_free_audit_and_beginner_cli_setup_plan.md` (2026-10-20). Each finding was checked against the code
at `6e493dc` (the same as GitHub's `main`) before planning. **No code was changed for this document.**

## 1. The audit's findings, checked against the code

| Finding | Verdict | Evidence |
|---|---|---|
| **A. SSRF / DNS rebinding** | Already known (F8, F9 in `docs/security-audit.md`); one part still worth a live test | `src/guard.ts` checks DNS over HTTPS, then `fetch()` resolves again (Workers can't pin the address), and every redirect hop is re-checked. In the rendering browser, IP literals, `localhost`, local suffixes and single-label names are blocked (verified live). Not covered: a **hostname that resolves to a private or loopback address** (for example `127.0.0.1.nip.io`) requested by a rendered page. |
| **B. Budget charged before validation** | **Confirmed** | `src/index.ts`: `pageRead()` (20 a minute, 1,000 a day, and one shared unit) runs before `readBody()` and `parseFormats()` on `/v2/scrape`, and before `loadSetup()` on `/run/{id}`. So malformed bodies, unknown formats, blocked addresses, unknown setup IDs and **cache hits** all spend budget. `/v2/crawl` spends a crawl before checking the request. |
| **C. Control characters in `/run/{id}` text** | **Mostly mitigated; two gaps** | `src/scrape.ts` strips C0 controls (including ESC), DEL, bidi and zero-width characters from page text and metadata when it extracts them, and links are rebuilt as URLs. Gaps: **AI-extracted facts** are printed as returned, and **carriage return and the C1 range** (U+0080 to U+009F) are never stripped. |
| **D. `--api-url` allows plain HTTP** | **Confirmed** | `cli/src/config.ts` `checkApiUrl()` accepts `http://` to any host, from the flag, `CRAWLER_FREE_API_URL` or the settings file. |
| **E. Symlinks and races in output** | **Partly confirmed** | New files use exclusive create (`wx`), which refuses an existing path or link. With `--force` (or "yes"), writes use `w`, which **follows a symbolic link at the target**. `crawl`'s folder check is separate from its writes. |
| **F. Docs lead with bypassing OS warnings** | **Confirmed** (docs) | `cli/README.md` "Standalone downloads" gives "Run anyway", `Unblock-File` and `xattr` before the verification steps. It never tells anyone to disable SmartScreen, Gatekeeper or antivirus. |
| **G. Shared budgets** | Ongoing (no single bug) | Per-connection and per-network limits plus shared daily budgets are in place, and the kill switch exists. Fixing B makes every unit spent correspond to real work. |
| **H. Published artefacts not tested end to end** | Mostly done already | npm 0.1.0, 0.1.1 and 0.1.2 were each installed from the registry with `npx` in an empty folder (Windows). The 0.1.2 Windows download was checked against `SHA256SUMS.txt` and GitHub's provenance, then run without Node. CI runs the CLI tests and a clean install on Linux and macOS. Not done: macOS and Linux downloads by hand, PowerShell 7, upgrade from an older release. |
| **I. Dependency advisories** | Re-run today, unchanged | `npm audit --omit=dev`: 0. `npm audit`: 5 high, all development tools (wrangler, miniflare, sharp, undici, vitest-pool-workers); the only offered fix is a breaking downgrade. |

## 2. Decisions (my recommendation first)

- **E1. What spends the budget.** Validate first (body, formats, address shape, setup exists, crawl options), then charge. Per-connection limits count every *valid* request, cached or not. The **shared** page-read budget counts only fresh page fetches (cache misses), since a cached answer does no outside work. Invalid requests cost no D1 writes at all; they're already capped at 64 KB and cost only Worker CPU, which no counter could save.
- **E2. Plain HTTP for `--api-url`.** Allow `http://` only for loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`); everything else must be `https://`, with **no override**. A self-hosted Worker always has HTTPS, and loopback covers local development. The alternative is an opt-in flag such as `--allow-insecure-http` with a warning.
- **E3. Live test of the rendering browser** (needs your OK, like the F9 test). A rendered test page requests `127.0.0.1.nip.io` (resolves to 127.0.0.1) and a name for a private range. If either connects, the options are:
  - block known "resolves-to-any-IP" services in `rejectRequestPattern`, which is partial;
  - or turn rendering off (`npx wrangler secret delete CF_BROWSER_TOKEN`), which loses JavaScript-only sites.
- **E4. Where interactive mode saves.** `Documents/Crawler Free` (the platform's Documents folder, falling back to the home folder), with "this folder" and "choose a folder" as choices. Explicit commands keep `./crawler-free-output/`, so scripts don't change.
- **E5. "Open the folder" after saving.** Interactive only. It runs the system's own file manager (`explorer` / `open` / `xdg-open`) with `execFile`: a fixed program, the folder as its only argument, and no shell. This adds the CLI's first child process, kept to one small audited module; the test that bans shell commands in `cli/src` would allow exactly that.
- **E6. Installing without Node.js and without warnings.** Paid signing (a Windows code-signing certificate, plus an Apple Developer ID and notarisation) costs money every year. Recommendation: free package-manager channels that install, put the command on the PATH and update it:
  - a **Homebrew tap** for macOS and Linux;
  - a **Scoop bucket** for Windows.

  Both would be generated from the release workflow with checksums. The unsigned archives stay as an "advanced" option. The alternatives are paying for signing, or deferring installers.

## 3. Phases (each stops for your review; nothing is deployed, published or released without your OK)

**Phase A: safety fixes.** The Worker parts need a deploy afterwards (your OK).
1. **Budget order (E1):**
   - On `/v2/scrape`, read and validate first (body, formats, `checkUrl` without network), then charge per-connection, and spend the shared unit only on a cache miss (moved into `scrape()`).
   - On `/run/{id}`, load the setup first.
   - On `/v2/crawl`, check the body, options and address before the daily crawl limits.

   Tests: malformed JSON, unknown formats, blocked addresses, unknown setup IDs and cache hits write no counter rows and spend nothing shared; valid requests still count; the limits still refuse at the limit.
2. **Terminal safety:**
   - `/run/{id}`'s text answer strips C0 except tab and newline, plus carriage return, the C1 range, bidi and zero-width characters, including in AI facts.
   - JSON answers and saved files stay exact.
   - Tests: ESC/OSC/CSI, CR and C1 in page text and in facts, through `/run` text, `/run?format=json`, and the CLI's display.
3. **HTTPS policy (E2)** in `checkApiUrl` (flag, environment variable and settings file). Tests: https; `localhost`, `127.0.0.1`, `[::1]` and `*.localhost` over http; remote http refused; credentials and malformed addresses.
4. **Safe replacing:**
   - When replacing is allowed, write to a new temporary file beside the target (exclusive create), then rename it over the target. A symbolic link is then replaced, not written through, and a crash never leaves a half-written file.
   - A folder at the target path is refused.
   - Tests: a link at the target (skipped where the system won't let the tests create links), a folder at the target, spaces and non-ASCII paths, crawl name collisions, interrupted crawls.
5. **E3 live test** (only with your OK), with results recorded either way.
6. **Checks:** both typechecks and test suites, both audits, the package and build checks.

**Phase B: beginner mode** (CLI only; a new npm version and release need your OK).
1. **No arguments, in a terminal:** a numbered menu (1 read one page (default), 2 read a whole website, 3 look up facts, 4 check or change setup, 5 help and examples). It asks only for what that choice needs, with Enter taking the default. Without a terminal, it keeps today's behaviour: help on stderr, exit 2, no prompts.
2. **Interactive saving (E4):** saves to `Documents/Crawler Free`, prints the full path, then offers (E5) to open the folder, read another page, or exit.
3. **`doctor`:** a plain summary ("Everything looks ready.") and **one** next step for each failure: offline or DNS, timeout, the service's 429/503, a bad settings file, an unwritable folder, old Node.
4. **Unchanged:** Ctrl+C behaviour (already clean), explicit commands, `--json`, `--stdout`, `-q` and the exit codes.
5. **Tests:** the menu (numbers, Enter for defaults, three wrong answers), no menu without a terminal, Documents fallback, the folder opener not called in scripts, and `doctor`'s messages.

**Phase C: documentation and installing.**
1. **README:** a "In a terminal" section with two clear choices: **"I have Node.js"** (`npx crawler-free`) and **"I don't have Node.js"** (the package managers from E6, or the advanced unsigned download).
2. **`cli/README.md` downloads section:** reordered so that verifying comes **before** running. It explains that a checksum only proves the file matches the list published with it, while provenance shows GitHub built it from this repository. The warnings are explained after that, as "what you'll see and why", never as a step to switch protections off.
3. **E6 channels**, if chosen: a tap and a bucket, updated by the release workflow, with install, update and uninstall commands tested on clean runners.
4. **No `curl | sh` or `irm | iex` installer.** The saved-setup `irm` command already only prints text.

## 4. Open security concerns (beyond the fixes above)

- **DNS rebinding** in the main fetch path can't be closed in code on Workers (no address pinning). It stays documented, relying on Cloudflare's network not routing to private ranges, which isn't verifiable from outside.
- **Distributed abuse** of the keyless service (many addresses, IPv6 rotation) is limited by the shared daily budgets and the kill switch, not prevented. The Workers Free request quota (100,000 a day) is the real ceiling, and no counter can protect it.
- **Unsigned downloads** remain a trust gap until E6 or paid signing is in place.

## 5. Phase A result (2026-10-20; committed `d3c721d` and `5db188a`; Worker deployed as version `f509bce2`)

**Live checks after the deploy:**
- **Budget order:** counters read from production D1 before and after each step, for the caller's own day count and the shared page reads.
  - Three invalid requests (malformed JSON, a blocked address, bad formats) each got `400` and changed neither count (33 and 14).
  - A fresh read (`MISS`) added 1 to each (34 and 15).
  - The same read again (`HIT`) added 1 to the caller's count only (35 and 15).
- **`/run` text:** a temporary saved setup for a test page with a C1 control character (U+009B) in its text.
  - `/run/{id}` answered `text/plain` without it, and with no other control characters.
  - `?format=json` still had it.
  - The setup was deleted afterwards.
  - (Carriage returns can't reach `/run` from a page: HTML parsing already turns them into newlines.)

- **Budget order (E1)**, `src/index.ts`, `src/scrape.ts`, `src/setups.ts`:
  - **What's checked first:** `/v2/scrape` checks the body, formats and address shape before any limit. `/run/{id}` loads the setup first. `/v2/crawl` checks the body, options and address before the daily crawl limits.
  - **What's charged:** per-connection limits count every valid read, cached or not. The shared page-read unit is spent in `scrape()`'s new `onMiss` step, only on a cache miss and before any fetch. Crawl pages don't pass it; they're charged when queued, as before.
  - **Tests:** `test/charging.test.ts`, 5 new. Four of them fail against the previous code, confirming they test the change. The fifth isn't run against the old code, because there it would fetch from the internet.
- **Terminal safety (finding C)**, `src/setups.ts` `forTerminal()`:
  - `/run/{id}`'s text answer drops C0 controls except tab and newline, DEL, the C1 range, bidi overrides and zero-width characters, and turns carriage returns into newlines.
  - AI facts and links are covered too. `?format=json` and the cache are unchanged.
  - Tests: `test/terminal.test.ts`, 3 new, including through the real route.
- **HTTPS policy (E2)**, `cli/src/config.ts`: plain `http://` is accepted only for `localhost`, `*.localhost`, `127.x.x.x` and `[::1]`, whether it comes from `--api-url`, `CRAWLER_FREE_API_URL` or the settings file. Tests in `cli/test/core.test.ts`.
- **Safe replacing (finding E)**, `cli/src/output.ts` `replaceFile()`, used by `scrape`, `extract` and `crawl`:
  - When replacing is allowed, the content goes into a new temporary file beside the target (exclusive create), which is then renamed over the target. A symbolic link at the target is replaced, not written through, and a crash never leaves a half-written file.
  - A folder at the target is refused.
  - Tests: `cli/test/files.test.ts`. The two symbolic-link tests skip on Windows accounts that can't create links; CI runs them on Linux and macOS.
- **E3 live test:** run on 2026-10-20 against the hosted service with the owner's approval. The results were reported to the owner directly, and the details stay out of this public file. On the owner's decision, **page rendering was switched off in production the same day** (the `CF_BROWSER_TOKEN` secret was deleted; version `7f86b723`).
  - Afterwards, ordinary pages still scrape normally (checked on example.com and quotes.toscrape.com).
  - A JavaScript-only page (quotes.toscrape.com/js/) now answers `503 RENDER_BUDGET_EXHAUSTED`.
  - Turning rendering back on needs a new Browser Run token (`npx wrangler secret put CF_BROWSER_TOKEN`) and a decision on how to close the gap.
- **Checks:**
  - `npm run typecheck` passed; `npm test` 44/44.
  - `npm run typecheck:cli` passed; `npm run test:cli` 80 passed, 2 skipped (see above).
  - Both builds passed; `public/` is unchanged.
  - `npm audit --omit=dev` found 0 vulnerabilities; the npm package contents are unchanged.
