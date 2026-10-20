# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

1. Go to https://github.com/artthavv999/crawler-free/security/advisories/new ("Report a vulnerability").
2. Describe the problem, the requests that show it, what an attacker gains, and any fix you suggest.

If that page isn't available, open a public issue that only asks for a private contact, with **no details**:
https://github.com/artthavv999/crawler-free/issues

We aim to acknowledge reports within 7 days and to say what we'll do about them. Reporters are credited in the fix's
release notes unless they'd rather not be.

## What counts

In scope, for the code in this repository and the public instance at https://crawler-free.crawler-free.workers.dev:

- Making the crawler fetch private, local or internal addresses (SSRF), or getting around robots.txt
- Getting around the per-connection rate limits or the request size limits
- Cross-site scripting or HTML injection on the web page
- Reading or deleting another person's crawl results or saved setups without their link
- Exposure of secrets, such as the Browser Run token
- Weaknesses in the GitHub Actions workflows or the dependency supply chain
- The `crawler-free` command (`cli/`) and its npm package. For example: saving outside the folder you chose,
  replacing a file without asking, letting a page's content run anything or reach your terminal as escape sequences,
  storing secrets, or a published package that doesn't match this repository's source

Not vulnerabilities:

- The free limits themselves, or the shared daily budgets running out
- Volumetric denial of service
- Scanner output with no demonstrated impact
- Content of the third-party pages that Crawler Free reads

Please don't run load tests, fuzzers or intrusive scans against the public instance; it runs on a shared free plan.
Use a local copy instead: `npm ci`, then `npx wrangler dev -c wrangler.ci.toml` (no Cloudflare account needed).
Don't access, change or delete data that isn't yours.

## Not security issues

To stop Crawler Free reading your site, disallow `CrawlerFree` in your robots.txt. For abuse reports or opt-outs, open
an issue: https://github.com/artthavv999/crawler-free/issues

## Supported versions

Only the latest commit on `main`, which is what the public instance runs.
