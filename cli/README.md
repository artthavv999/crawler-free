# crawler-free

Read web pages as clean Markdown, links or facts from your terminal, using the free [Crawler Free](https://github.com/artthavv999/crawler-free) service. No account, no key, no sign-up.

```bash
npx crawler-free scrape https://example.com
```

That saves `./crawler-free-output/example.com.md` and prints where it went.

## Install

You need [Node.js](https://nodejs.org) 22 or newer. `node --version` shows the one you have.

- **Without installing:** put `npx` in front of each command, as above. The first time, npx asks to download the package; type `y`.
- **Installed once**, so you can type just `crawler-free`:

  ```bash
  npm install --global crawler-free
  ```

  On a Mac or Linux, if that fails with `EACCES`, use `npx` instead, or see [npm's guide to fixing permissions](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).

The package has no dependencies: it's one file that uses only what comes with Node.js.

## Commands

| Command | What it does |
|---|---|
| `crawler-free scrape <url>` | Reads one page and saves it as Markdown. `-f links` saves its links, `-f json` everything (text, links and page details) |
| `crawler-free crawl <url>` | Reads a whole website, up to 100 pages, into a folder: one `.md` file per page, plus `pages.json` |
| `crawler-free extract <url> --fields title,price` | Looks up facts on a page with a small AI model and saves them as JSON |
| `crawler-free setup` | Chooses the service: the free hosted one (the default) or your own copy |
| `crawler-free doctor` | Checks Node.js, your settings, the connection and the results folder |

`crawler-free --help` lists every option. Some examples:

```bash
crawler-free scrape example.com --format links
crawler-free scrape https://example.com --stdout > page.md
crawler-free crawl https://books.toscrape.com/ --limit 20
crawler-free extract https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html --fields title,price,availability
```

## Where results go

- **The folder:** results go into `./crawler-free-output/`, inside the folder you run the command from.
- **File names:** they come from the page's address, never its content. For example, `example.com_docs_intro.md` for a page, `<page>.facts.json` for facts, and `<site>-crawl/` for a crawl. `-o` (`--output`) chooses another file or folder.
- **Existing files:** they're never replaced silently. You're asked first; in a script the command stops (exit code 6) unless you add `--force`. This is checked before anything is read, so it never uses up your limits.

## In scripts

- **Output:**
  - `--json` prints one JSON summary, or the error, on stdout.
  - `--stdout` prints the data itself (`scrape` and `extract`).
  - `-q` prints only the saved file's or folder's path.
- **Progress** always goes to stderr. The command never asks questions unless it's running in a terminal.
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | Done |
  | 1 | Service error, or every page of a crawl failed |
  | 2 | Wrong command, option or address |
  | 3 | Refused: the site's robots.txt, a private address, or the site said no |
  | 4 | A limit was reached; the message says when to try again |
  | 5 | Network problem or timeout. For `crawl`: it stopped waiting, and what was done is saved |
  | 6 | A results file problem: it exists, or can't be written |

## Limits

The hosted service is free and shared by everyone, so each connection has limits:

| What | Limit |
|---|---|
| Page reads | 20 a minute and 1,000 a day |
| Whole-website reads | 5 a day, up to 100 pages each |
| Fact look-ups | 20 a day |

- **Shared budgets:** some are shared by everyone and reset at 00:00 UTC.
- **Cache:** the same request within an hour comes from the cache.
- **No automatic retries:** reads, crawls and look-ups are never retried, so nothing uses your limits twice. A crawl's progress checks do wait and retry, within their own limits.

## Settings

None are needed: with no settings, every command uses the hosted service.

`crawler-free setup` saves your choice of service. Where the file goes:

| System | Settings file |
|---|---|
| Windows | `%APPDATA%\crawler-free\config.json` |
| macOS | `~/Library/Application Support/crawler-free/config.json` |
| Linux | `$XDG_CONFIG_HOME/crawler-free/config.json` (usually `~/.config/crawler-free/config.json`) |

- **What it holds:** only `{"mode": "hosted"}`, or your own service's address. Never keys, tokens or passwords.
- **For one run:** `--api-url <url>` or the `CRAWLER_FREE_API_URL` environment variable choose a service just for that run.
- **To remove it:** `crawler-free setup --reset`.

## Safety and privacy

- **The service reads the pages, not this program.** The Crawler Free service blocks private and local addresses, follows each site's robots.txt, and identifies itself to the site. This program never contacts those sites, and never runs anything it reads.
- **What gets sent:** only the page address and your options go to the service, with the user agent `crawler-free-cli/<version>`. There's no telemetry.
- **Page text in your terminal:** text from web pages shown on screen has control characters removed, so a page can't send escape sequences to your terminal. Saved files keep the text exactly.
- **Facts can be wrong:** they come from a small AI model, so check anything important against the page.

## If something goes wrong

- **Start with** `crawler-free doctor`. It checks everything and says what to fix.
- **PowerShell says "running scripts is disabled on this system":** type `crawler-free.cmd` (or `npx.cmd`) instead of `crawler-free` (or `npx`). Those versions aren't affected, and you don't need to change any settings.
- **An unexpected error:** set `CRAWLER_FREE_DEBUG=1` to add technical details.
- **Report problems** at https://github.com/artthavv999/crawler-free/issues

## Uninstall

```bash
crawler-free setup --reset
npm uninstall --global crawler-free
```

The first line removes the settings file, if you saved one. Results in `crawler-free-output` folders are yours, and stay.

## Licence

MIT. The source, and the service itself: https://github.com/artthavv999/crawler-free
