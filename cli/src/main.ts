import { checkOptionsFor, parse } from "./args";
import { ApiClient, type Fetch } from "./client";
import { resolveApiUrl } from "./config";
import { crawl, type Clock } from "./crawl";
import { doctor } from "./doctor";
import { CliError, EXIT } from "./errors";
import { extract } from "./extract";
import { menu } from "./menu";
import type { Ask } from "./output";
import { scrape } from "./scrape";
import { setup } from "./setup";
import { Ui, type Io } from "./ui";
import { VERSION } from "./version";

export const HELP = `crawler-free ${VERSION}: read web pages as clean Markdown, links or facts, using the free Crawler Free service.

Usage
  crawler-free <command> [options]
  crawler-free             (on its own, in a terminal: a guided menu that asks what to do)

Commands
  scrape <url>        Read one page and save it as a file
  crawl <url>         Read a whole website, page by page, into a folder
  extract <url>       Look up facts on a page (for example a title and a price) and save them as JSON
  setup               Choose the service to use: the free hosted one (the default) or your own copy
  doctor              Check Node.js, your settings, the connection to the service and the results folder

No setup is needed for the hosted service: every command works straight away.

Examples
  crawler-free scrape https://example.com
  crawler-free scrape example.com --format links
  crawler-free scrape https://example.com --output notes/example.md
  crawler-free scrape https://example.com --stdout > page.md
  crawler-free crawl https://books.toscrape.com/ --limit 20
  crawler-free extract https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html --fields title,price

scrape options
  -f, --format <name> markdown (default), links (one per line) or json (text, links and page details)
  -o, --output <path> Save here: a file, or a folder ending in / (default: ./crawler-free-output/)
  --stdout            Print the result instead of saving it (progress stays on stderr)
  --force             Replace an existing file without asking

crawl options
  --limit <n>         Most pages to read, 1 to 100 (default 10)
  --depth <n>         How many links away from the start page to go, 0 to 3 (default 2)
  --max-wait <min>    Stop waiting after this many minutes and save what's done (default 30)
  -o, --output <dir>  Folder for the results (default: ./crawler-free-output/<site>-crawl/)
  --force             Use a folder that already has files, replacing files with the same names
  Saves one .md file per page and pages.json (every page's address, title and file, and any pages that failed).
  Stays on the same site, under the start address's folder, and follows each site's robots.txt.

extract options
  --fields <names>    The facts to look up, separated by commas: 1 to 20 names (spaces become _), for example title,price
  -o, --output <path> Save here: a file, or a folder ending in / (default: ./crawler-free-output/<page>.facts.json)
  --stdout            Print the facts as JSON instead of saving them
  --force             Replace an existing file without asking
  Facts are read by a small AI model, so they can be missing or wrong: check anything important against the page.

setup options
  (none)              Ask which service to use (in a script, with no one to ask, it picks the hosted service)
  --hosted            Use the free hosted service, without questions
  --api-url <url>     Use your own copy of Crawler Free at this address, without questions
  --force             Save even if the connection check fails
  --reset             Remove the settings file and go back to the hosted service
  The connection is checked before anything is saved. Only the choice is saved: no keys, tokens or passwords.

Options for every command
  --api-url <url>     Use another Crawler Free server (default: the hosted service)
  --timeout <seconds> Stop waiting for one answer from the service after this long (default 60)
  --json              Print a JSON summary (or error) on stdout, for scripts
  -q, --quiet         No progress messages; prints only the saved file's or folder's path
  -h, --help          Show this help
  -v, --version       Show the version

Existing files are never replaced silently: you're asked first, and in scripts the command stops unless --force is
given. This is checked before anything is read, so it never uses up your limits.

Exit codes
  0 done   1 service error   2 wrong command or option   3 refused (robots.txt, blocked site)
  4 limit reached   5 network problem or timeout (crawl: stopped waiting; what was done is saved)
  6 results file problem

The hosted service is free and shared, with limits per connection: 20 pages a minute and 1,000 a day,
5 whole-website reads a day of up to 100 pages each, and 20 fact look-ups a day:
https://crawler-free.crawler-free.workers.dev
Pages are always read by the service, which follows each site's robots.txt; this program never contacts those sites itself.
`;

export interface Deps extends Io {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  homedir: string;
  cwd: string;
  nodeVersion: string;
  // True in the standalone download, which has Node.js built in.
  standalone?: boolean;
  fetch?: Fetch;
  // Present only in an interactive terminal: asks a question and returns the answer.
  ask?: Ask;
  // Waiting between crawl progress checks; tests replace it.
  clock?: Clock;
  // True when stdout is a terminal too: the guided menu needs a person on both ends.
  stdoutIsTTY?: boolean;
  // Opens a folder in the system's file manager (only the guided menu uses it).
  openFolder?: (dir: string) => Promise<boolean>;
}

const realClock: Clock = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };

export async function main(d: Deps): Promise<number> {
  let ui = new Ui(d, { json: d.argv.includes("--json"), quiet: false });
  try {
    // Nothing after the command, with a person at a terminal: the guided menu. Its choices run as ordinary commands.
    if (d.argv.length === 0 && d.ask && d.stdoutIsTTY) {
      return await menu({
        ask: d.ask, stderr: d.stderr, stdout: d.stdout, cwd: d.cwd, help: HELP, openFolder: d.openFolder,
        sys: { platform: d.platform, env: d.env, homedir: d.homedir },
        run: (argv) => main({ ...d, argv }),
      });
    }
    const a = parse(d.argv);
    ui = new Ui(d, { json: a.json, quiet: a.quiet });
    if (a.version) {
      if (a.json) ui.json({ ok: true, version: VERSION });
      else ui.out(`${VERSION}\n`);
      return EXIT.ok;
    }
    if (a.help || a.command === "help") {
      ui.out(HELP);
      return EXIT.ok;
    }
    if (!a.command) {
      d.stderr(HELP);
      return EXIT.usage;
    }
    const sys = { platform: d.platform, env: d.env, homedir: d.homedir };
    if (a.command === "doctor") {
      checkOptionsFor("doctor", a);
      return await doctor({ sys, cwd: d.cwd, nodeVersion: d.nodeVersion, standalone: d.standalone, apiUrlFlag: a.apiUrl, timeoutMs: a.timeoutMs, fetch: d.fetch, ui, version: VERSION });
    }
    if (a.command === "scrape") {
      checkOptionsFor("scrape", a);
      const { url } = await resolveApiUrl(a.apiUrl, sys);
      const client = new ApiClient({ baseUrl: url, timeoutMs: a.timeoutMs, fetch: d.fetch });
      return await scrape({ args: a, client, ui, cwd: d.cwd, ask: d.ask });
    }
    if (a.command === "crawl") {
      checkOptionsFor("crawl", a);
      const { url } = await resolveApiUrl(a.apiUrl, sys);
      const client = new ApiClient({ baseUrl: url, timeoutMs: a.timeoutMs, fetch: d.fetch });
      return await crawl({ args: a, client, ui, cwd: d.cwd, ask: d.ask, clock: d.clock ?? realClock });
    }
    if (a.command === "extract") {
      checkOptionsFor("extract", a);
      const { url } = await resolveApiUrl(a.apiUrl, sys);
      const client = new ApiClient({ baseUrl: url, timeoutMs: a.timeoutMs, fetch: d.fetch });
      return await extract({ args: a, client, ui, cwd: d.cwd, ask: d.ask });
    }
    if (a.command === "setup") {
      checkOptionsFor("setup", a);
      return await setup({ args: a, sys, ui, ask: d.ask, fetch: d.fetch });
    }
    throw new CliError(`Unknown command "${a.command}".`, EXIT.usage, "USAGE", "Run `crawler-free --help` to see the commands.");
  } catch (e) {
    if (e instanceof CliError) {
      ui.fail(e);
      return e.exitCode;
    }
    // Unexpected: a short message by default; the stack trace only when the user asks for it.
    if (d.env.CRAWLER_FREE_DEBUG) d.stderr(`${(e as Error)?.stack ?? String(e)}\n`);
    ui.fail(new CliError("Something went wrong inside crawler-free.", EXIT.failed, "INTERNAL",
      "Run it again with CRAWLER_FREE_DEBUG=1 for details, and report it at https://github.com/artthavv999/crawler-free/issues"));
    return EXIT.failed;
  }
}
