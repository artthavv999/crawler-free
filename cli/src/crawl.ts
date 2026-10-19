import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Args } from "./args";
import type { ApiClient } from "./client";
import { CliError, EXIT } from "./errors";
import { cantSave, fileNameFor, hostSlug, inside, mayUseFolder, OUTPUT_DIR, type Ask } from "./output";
import { pageUrl } from "./scrape";
import type { Ui } from "./ui";

export interface Clock { sleep(ms: number): Promise<void>; now(): number }

interface Page { markdown?: unknown; metadata?: { sourceURL?: unknown; url?: unknown; title?: unknown } }
interface Failure { url: string; code: string; error: string }
interface Status {
  status?: unknown; completed?: unknown; total?: unknown; failed?: unknown; expiresAt?: unknown;
  next?: unknown; data?: unknown; failures?: unknown;
}

// Polling (docs/cli-plan.md, D9): first check after 3 s, slowing to every 15 s while nothing changes, back to 3 s
// when something does; Retry-After is honoured; network errors on a check are retried 3 times. The API allows
// 60 checks a minute and 2,000 a day per connection.
const FIRST_WAIT = 3_000;
const SLOWEST_WAIT = 15_000;
const NETWORK_RETRIES = 3;
const MAX_RESULT_PAGES = 20; // 100 pages at 10 per answer, with room to spare; stops a `next` loop

const usage = (message: string, hint?: string) => new CliError(message, EXIT.usage, "USAGE", hint);
const badAnswer = (why: string) => new CliError(`The service's answer was unexpected: ${why}.`, EXIT.failed, "BAD_RESPONSE", "Run `crawler-free doctor` to check the service address.");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function wholeNumber(raw: string | undefined, flag: string, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw usage(`${flag} must be a whole number from ${min} to ${max}.`);
  return n;
}

// Only follow addresses on the service we were given: a status or `next` link elsewhere is refused.
function onService(link: unknown, base: string): string {
  if (typeof link !== "string") throw badAnswer("no status address");
  let u: URL;
  try { u = new URL(link); } catch { throw badAnswer("a status address that isn't a web address"); }
  if (u.origin !== new URL(base).origin) throw badAnswer(`it pointed to another server (${u.origin})`);
  return u.href;
}

// crawler-free crawl <url>: a whole website through the hosted API. Starts the job, waits for it, fetches every
// results page and saves one Markdown file per page plus pages.json. Partial failures are reported, not hidden.
export async function crawl(o: { args: Args; client: ApiClient; ui: Ui; cwd: string; ask?: Ask; clock: Clock }): Promise<number> {
  const { args: a, client, ui, clock } = o;
  if (!a.rest.length) throw usage("Give the address of the website to read.", "For example: crawler-free crawl https://example.com");
  if (a.rest.length > 1) throw usage(`crawl starts from one address (got ${a.rest.length}).`);
  const start = pageUrl(a.rest[0]);
  const limit = wholeNumber(a.limit, "--limit", 1, 100, 10);
  const depth = wholeNumber(a.depth, "--depth", 0, 3, 2);
  const maxWait = wholeNumber(a.maxWait, "--max-wait", 1, 120, 30);
  if (a.output !== undefined && a.output.trim() === "") throw usage("--output needs a folder name.");
  const folder = resolve(o.cwd, a.output ?? `${OUTPUT_DIR}/${hostSlug(start)}-crawl`);
  const replace = await mayUseFolder(folder, { force: a.force, ask: ui.mode.json ? undefined : o.ask }); // before any quota is used

  ui.progress(`Starting a whole-website read of ${start.href} (up to ${limit} page${limit === 1 ? "" : "s"}, ${depth} link${depth === 1 ? "" : "s"} deep).`);
  ui.progress("Each one counts toward the free limit of 5 whole-website reads a day per connection.");
  const job = await client.post<{ id?: unknown; url?: unknown; warning?: unknown }>("/v2/crawl", { url: start.href, limit, maxDiscoveryDepth: depth });
  if (typeof job.id !== "string") throw badAnswer("no job ID");
  const statusUrl = onService(job.url, client.baseUrl);
  if (typeof job.warning === "string") ui.progress(`Note: ${job.warning}`);

  // Wait for the crawl, within --max-wait.
  const deadline = clock.now() + maxWait * 60_000;
  let wait = FIRST_WAIT;
  let networkFailures = 0;
  let shown = "";
  let status: Status = {};
  let finished = false;
  for (;;) {
    await clock.sleep(Math.max(0, Math.min(wait, deadline - clock.now())));
    try {
      status = await client.get<Status>(statusUrl);
      networkFailures = 0;
    } catch (e) {
      const err = e as CliError;
      if (err.code === "RATE_LIMITED" && clock.now() < deadline) {
        wait = (err.retryAfter ?? 30) * 1000;
        ui.progress(`Checking too often for the free limits; waiting ${Math.ceil(wait / 1000)} s.`);
        continue;
      }
      if (err.exitCode === EXIT.network && ++networkFailures <= NETWORK_RETRIES && clock.now() < deadline) {
        wait = Math.min(wait * 2, SLOWEST_WAIT);
        ui.progress(`Couldn't check progress (${err.message}); trying again.`);
        continue;
      }
      throw e;
    }
    const done = num(status.completed) ?? 0, failed = num(status.failed), total = (num(status.total) ?? 0) + (failed ?? 0);
    const line = `  ${done} of ${total} page${total === 1 ? "" : "s"} read${failed ? `, ${failed} failed` : ""}`;
    if (line !== shown) {
      ui.progress(line);
      shown = line;
      wait = FIRST_WAIT;
    } else {
      wait = Math.min(Math.round(wait * 1.5), SLOWEST_WAIT);
    }
    if (status.status === "completed") { finished = true; break; }
    if (status.status !== "scraping") throw badAnswer(`status "${String(status.status)}"`);
    if (clock.now() >= deadline) break;
  }

  // Collect every results page (also when we stopped waiting: what's done so far is saved).
  const pages: Page[] = [];
  let answer = status;
  for (let n = 0; ; n++) {
    if (!Array.isArray(answer.data)) throw badAnswer("no page list");
    pages.push(...(answer.data as Page[]));
    if (answer.next === null || answer.next === undefined) break;
    if (n + 1 >= MAX_RESULT_PAGES) throw badAnswer("too many results pages");
    answer = await client.get<Status>(onService(answer.next, client.baseUrl));
  }
  const failedCount = num(status.failed) ?? null; // null: an older server that doesn't report failures
  const failedPages: Failure[] = Array.isArray(status.failures)
    ? (status.failures as Failure[]).filter((f) => f && typeof f.url === "string").map((f) => ({ url: f.url, code: String(f.code ?? ""), error: String(f.error ?? "") }))
    : [];

  // Save one Markdown file per page, named from its address (never its content), plus pages.json.
  try {
    await mkdir(folder, { recursive: true });
  } catch (e) {
    throw cantSave(folder, e);
  }
  const used = new Set<string>();
  const saved: { url: string; title: string; file: string; characters: number }[] = [];
  for (const p of pages) {
    if (typeof p?.markdown !== "string") continue;
    const address = typeof p.metadata?.sourceURL === "string" ? p.metadata.sourceURL : typeof p.metadata?.url === "string" ? p.metadata.url : "";
    let name: string;
    try { name = fileNameFor(new URL(address), "markdown"); } catch { name = `page-${saved.length + 1}.md`; }
    const base = name.slice(0, -".md".length);
    for (let i = 2; used.has(name); i++) name = `${base}-${i}.md`; // two addresses, one name: number the later ones
    used.add(name);
    const path = inside(folder, name);
    await save(path, p.markdown && !p.markdown.endsWith("\n") ? `${p.markdown}\n` : p.markdown, replace);
    saved.push({ url: address, title: typeof p.metadata?.title === "string" ? p.metadata.title : "", file: name, characters: p.markdown.length });
  }
  const expiresAt = typeof status.expiresAt === "string" ? status.expiresAt : null;
  const manifest = {
    start: start.href, jobId: job.id, limit, depth, finished, expiresAt,
    pages: saved, failed: failedCount, failures: failedPages,
  };
  await save(inside(folder, "pages.json"), `${JSON.stringify(manifest, null, 2)}\n`, replace); // page files all end in .md

  // Report.
  const exit = !finished ? EXIT.network : saved.length === 0 && (failedCount ?? 0) > 0 ? EXIT.failed : EXIT.ok;
  if (ui.mode.json) {
    ui.json({ ok: exit === EXIT.ok, command: "crawl", url: start.href, jobId: job.id, finished, folder, pages: saved.length, failed: failedCount, failures: failedPages, expiresAt });
  } else if (ui.mode.quiet) {
    ui.out(`${folder}\n`);
  } else {
    let text = `Saved ${saved.length} page${saved.length === 1 ? "" : "s"} to ${folder} (one .md file each, and pages.json)\n`;
    if (failedCount === null) text += "This server doesn't report pages that failed, so some may be missing.\n";
    else if (failedCount > 0) {
      text += `${failedCount} page${failedCount === 1 ? "" : "s"} couldn't be read:\n`;
      for (const f of failedPages.slice(0, 10)) text += `  - ${f.url} (${f.code}${f.error ? `: ${f.error}` : ""})\n`;
      if (failedPages.length > 10) text += `  ...and ${failedPages.length - 10} more, listed in pages.json\n`;
    }
    if (!finished) {
      text += `Stopped waiting after ${maxWait} minute${maxWait === 1 ? "" : "s"}; the crawl is still running on the service.\n`
        + `Saved what was finished. All results stay available${expiresAt ? ` until ${expiresAt}` : ""} at ${statusUrl}\n`;
    }
    ui.out(text);
  }
  if (exit === EXIT.failed && !ui.mode.json) ui.progress("No page could be read; see the reasons above.");
  return exit;
}

async function save(path: string, content: string, replace: boolean): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: replace ? "w" : "wx" });
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") {
      throw new CliError(`${path} appeared while the crawl was running; nothing was replaced.`, EXIT.output, "FILE_EXISTS", "Run it again with --force, or choose another folder with --output.");
    }
    throw cantSave(path, e);
  }
}
