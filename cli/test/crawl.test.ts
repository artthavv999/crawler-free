import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/crawl";
import { EXIT } from "../src/errors";
import { OUTPUT_DIR } from "../src/output";
import { mockApi, run, sendJson, type Hit } from "./helpers";

const EXPIRES = "2026-10-20T12:00:00.000Z";
const FOLDER = join(OUTPUT_DIR, "example.com-crawl");

const page = (url: string, title = "A page", markdown = `# ${title}\n\nText.`) =>
  ({ markdown, metadata: { title, url, sourceURL: url, statusCode: 200 } });

// One answer from GET /v2/crawl/{id}, shaped like the real API (src/crawl.ts crawlStatus) after the D5 change.
const status = (o: Record<string, unknown> = {}) =>
  ({ success: true, status: "scraping", completed: 0, total: 1, failed: 0, creditsUsed: 0, expiresAt: EXPIRES, next: null, data: [], ...o });

// A scripted answer: JSON with a status code, or "drop" to cut the connection (a network failure).
type Reply = { status?: number; body: unknown; headers?: Record<string, string> } | "drop";
type Script = (api: string) => { start?: Reply; polls: Reply[]; more?: Record<string, Reply> };

let closeApi: (() => Promise<void>) | undefined;
afterEach(async () => { await closeApi?.(); closeApi = undefined; });

// A stand-in for the crawl endpoints: POST /v2/crawl starts job-1, each status check takes the next scripted answer
// (the last one repeats), and other addresses (later results pages) come from `more`.
async function crawlApi(script: Script) {
  let s: ReturnType<Script> | undefined;
  let poll = 0;
  const reply = (r: Reply, res: Parameters<Parameters<typeof mockApi>[0]>[1]) => {
    if (r === "drop") { res.socket?.destroy(); return; }
    sendJson(res, r.status ?? 200, r.body, r.headers);
  };
  const m = await mockApi((hit: Hit, res) => {
    if (!s) throw new Error("script not ready");
    if (hit.method === "POST" && hit.url === "/v2/crawl") return reply(s.start ?? { body: { success: true, id: "job-1", url: `${m.url}/v2/crawl/job-1` } }, res);
    if (hit.method === "GET" && hit.url === "/v2/crawl/job-1") return reply(s.polls[Math.min(poll++, s.polls.length - 1)], res);
    const more = s.more?.[hit.url];
    if (more) return reply(more, res);
    sendJson(res, 404, { success: false, code: "NOT_FOUND", error: `no route ${hit.method} ${hit.url}` });
  });
  s = script(m.url);
  closeApi = m.close;
  return m;
}

// Time that only moves when the crawl waits, so the tests check every pause without sleeping.
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  const clock: Clock = { sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t };
  return { clock, sleeps };
}

const crawl = async (m: { url: string }, extra: string[] = [], over: Parameters<typeof run>[1] = {}) => {
  const c = fakeClock();
  const r = await run(["crawl", "https://example.com/", "--api-url", m.url, ...extra], { clock: c.clock, ...over });
  return { ...r, sleeps: c.sleeps, folder: join(r.home, FOLDER) };
};
const manifest = async (folder: string) => JSON.parse(await readFile(join(folder, "pages.json"), "utf8"));
const hasFolder = (home: string) => readdir(home).then((names) => names.includes(OUTPUT_DIR));
const gets = (m: { hits: Hit[] }) => m.hits.filter((h) => h.method === "GET").length;

describe("crawler-free crawl", () => {
  it("starts a crawl, waits for it and saves one Markdown file per page plus pages.json", async () => {
    const failures = [{ url: "https://example.com/private", code: "ROBOTS_DISALLOWED", error: "blocked by robots.txt" }];
    const m = await crawlApi((api) => ({
      polls: [
        { body: status({ total: 3 }) },
        { body: status({ total: 3 }) },
        { body: status({ total: 3 }) },
        { body: status({ completed: 1, total: 3, data: [page("https://example.com/", "Home")] }) },
        { body: status({
          status: "completed", completed: 3, total: 3, failed: 1, failures,
          data: [page("https://example.com/", "Home"), page("https://example.com/docs/a", "A")],
          next: `${api}/v2/crawl/job-1?skip=10`,
        }) },
      ],
      more: { "/v2/crawl/job-1?skip=10": { body: status({ status: "completed", completed: 3, total: 3, failed: 1, data: [page("https://example.com/docs/b", "B")] }) } },
    }));
    const r = await crawl(m);

    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(m.hits[0].body)).toEqual({ url: "https://example.com/", limit: 10, maxDiscoveryDepth: 2 });
    // Checks every 3 s, slowing by half again each time nothing changes, back to 3 s when something does.
    expect(r.sleeps).toEqual([3000, 3000, 4500, 6750, 3000]);
    expect((await readdir(r.folder)).sort()).toEqual(["example.com.md", "example.com_docs_a.md", "example.com_docs_b.md", "pages.json"]);
    expect(await readFile(join(r.folder, "example.com_docs_a.md"), "utf8")).toBe("# A\n\nText.\n");
    expect(await manifest(r.folder)).toEqual({
      start: "https://example.com/", jobId: "job-1", limit: 10, depth: 2, finished: true, expiresAt: EXPIRES,
      pages: [
        { url: "https://example.com/", title: "Home", file: "example.com.md", characters: 13 },
        { url: "https://example.com/docs/a", title: "A", file: "example.com_docs_a.md", characters: 10 },
        { url: "https://example.com/docs/b", title: "B", file: "example.com_docs_b.md", characters: 10 },
      ],
      failed: 1, failures,
    });
    expect(r.stdout).toBe(`Saved 3 pages to ${r.folder} (one .md file each, and pages.json)\n`
      + "1 page couldn't be read:\n  - https://example.com/private (ROBOTS_DISALLOWED: blocked by robots.txt)\n");
    expect(r.stderr).toBe("Starting a whole-website read of https://example.com/ (up to 10 pages, 2 links deep).\n"
      + "Each one counts toward the free limit of 5 whole-website reads a day per connection.\n"
      + "  0 of 3 pages read\n  1 of 3 pages read\n  3 of 4 pages read, 1 failed\n");
  });

  it("sends --limit and --depth, saves into --output, and slows to one check every 15 s", async () => {
    const m = await crawlApi(() => ({
      polls: [...Array(7).fill({ body: status() }), { body: status({ status: "completed", completed: 1, data: [page("https://example.com/")] }) }],
    }));
    const r = await crawl(m, ["--limit", "1", "--depth", "0", "-o", "site"]);
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(m.hits[0].body)).toEqual({ url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0 });
    expect(r.sleeps).toEqual([3000, 3000, 4500, 6750, 10125, 15000, 15000, 15000]);
    expect(r.stderr).toContain("(up to 1 page, 0 links deep)");
    expect(await readdir(join(r.home, "site"))).toEqual(["example.com.md", "pages.json"]);
    expect(await hasFolder(r.home)).toBe(false);
  });

  it("waits as long as the service asks when checking too often, and retries a dropped connection", async () => {
    const m = await crawlApi(() => ({
      polls: [
        { status: 429, body: { success: false, code: "RATE_LIMITED", error: "Too many status checks. Try again in 20 seconds." }, headers: { "retry-after": "20" } },
        "drop",
        { body: status({ status: "completed", completed: 1, data: [page("https://example.com/")] }) },
      ],
    }));
    const r = await crawl(m);
    expect(r.code).toBe(EXIT.ok);
    expect(r.sleeps).toEqual([3000, 20000, 15000]);
    expect(r.stderr).toContain("Checking too often for the free limits; waiting 20 s.\n");
    expect(r.stderr).toMatch(/Couldn't check progress \(Couldn't reach 127\.0\.0\.1:\d+ .*\); trying again\.\n/);
  });

  it("gives up after 3 retries when the service can't be reached (exit 5), without creating a folder", async () => {
    const m = await crawlApi(() => ({ polls: ["drop"] }));
    const r = await crawl(m);
    expect(r.code).toBe(EXIT.network);
    expect(gets(m)).toBe(4);
    expect(r.sleeps).toEqual([3000, 6000, 12000, 15000]);
    expect(await hasFolder(r.home)).toBe(false);
  });

  it("stops waiting at --max-wait, saves what's done and exits 5, naming where the rest will be", async () => {
    const m = await crawlApi(() => ({ polls: [{ body: status({ completed: 1, total: 5, data: [page("https://example.com/")] }) }] }));
    const r = await crawl(m, ["--max-wait", "1"]);
    expect(r.code).toBe(EXIT.network);
    expect(r.sleeps.reduce((a, b) => a + b)).toBe(60_000);
    expect(r.sleeps.at(-1)).toBe(2625); // the last wait is cut short at the deadline
    expect(await readdir(r.folder)).toEqual(["example.com.md", "pages.json"]);
    expect(await manifest(r.folder)).toMatchObject({ finished: false, failed: 0, failures: [] });
    expect(r.stdout).toBe(`Saved 1 page to ${r.folder} (one .md file each, and pages.json)\n`
      + "Stopped waiting after 1 minute; the crawl is still running on the service.\n"
      + `Saved what was finished. All results stay available until ${EXPIRES} at ${m.url}/v2/crawl/job-1\n`);
  });

  it("reports a refused or limited start (exit 3, exit 4) without creating a folder", async () => {
    const robots = await crawlApi(() => ({ start: { status: 403, body: { success: false, code: "ROBOTS_DISALLOWED", error: "robots.txt disallows https://example.com/" } }, polls: [] }));
    const refused = await crawl(robots);
    expect(refused.code).toBe(EXIT.refused);
    expect(refused.stderr).toContain("Error: robots.txt disallows https://example.com/\nThe site's robots.txt asks crawlers not to read this page");
    expect(await hasFolder(refused.home)).toBe(false);
    await closeApi?.();

    const limited = await crawlApi(() => ({ start: { status: 429, body: { success: false, code: "RATE_LIMITED", error: "You've used all 5 whole-website reads allowed per day." }, headers: { "retry-after": "3600" } }, polls: [] }));
    const r = await crawl(limited, ["--json"]);
    expect(r.code).toBe(EXIT.limit);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", exitCode: EXIT.limit } });
    expect(await hasFolder(r.home)).toBe(false);
  });

  it("won't use a folder that already has files unless --force or a yes, checked before the crawl starts", async () => {
    const m = await crawlApi(() => ({ polls: [{ body: status({ status: "completed", completed: 1, data: [page("https://example.com/", "New")] }) }] }));
    const c = fakeClock();
    const home = (await run(["--version"])).home;
    const folder = join(home, FOLDER);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "example.com.md"), "old");
    await writeFile(join(folder, "notes.txt"), "mine");
    const again = (extra: string[], over: Parameters<typeof run>[1] = {}) =>
      run(["crawl", "https://example.com/", "--api-url", m.url, ...extra], { cwd: home, clock: c.clock, ...over });

    const script = await again([]);
    expect(script.code).toBe(EXIT.output);
    expect(script.stderr).toBe(`Error: ${folder} already has files in it.\nUse --force to replace files with the same names, or --output to choose another folder.\n`);
    const no = await again([], { ask: async () => "n" });
    expect(no.code).toBe(EXIT.output);
    expect(no.stderr).toContain("the crawl wasn't started");
    const json = await again(["--json"], { ask: async () => "y" }); // --json never asks
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: "FOLDER_NOT_EMPTY" } });
    expect(m.hits).toEqual([]);
    expect(await readFile(join(folder, "example.com.md"), "utf8")).toBe("old");

    const questions: string[] = [];
    const yes = await again([], { ask: async (q) => { questions.push(q); return "y"; } });
    expect(yes.code).toBe(EXIT.ok);
    expect(questions).toEqual([`${folder} already has files in it. Replace files with the same names? [y/N] `]);
    expect(await readFile(join(folder, "example.com.md"), "utf8")).toBe("# New\n\nText.\n");
    expect(await readFile(join(folder, "notes.txt"), "utf8")).toBe("mine"); // nothing is ever deleted
    expect((await again(["--force"])).code).toBe(EXIT.ok);

    await writeFile(join(home, "a-file"), "");
    const notFolder = await again(["-o", "a-file"]);
    expect(notFolder).toMatchObject({ code: EXIT.output, stderr: expect.stringContaining("is a file, not a folder") });
  });

  it("refuses status or results links that point to another server", async () => {
    const elsewhere = await crawlApi(() => ({ start: { body: { success: true, id: "job-1", url: "https://evil.example/v2/crawl/job-1" } }, polls: [] }));
    const r = await crawl(elsewhere);
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toContain("The service's answer was unexpected: it pointed to another server (https://evil.example).");
    expect(gets(elsewhere)).toBe(0);
    await closeApi?.();

    const next = await crawlApi(() => ({ polls: [{ body: status({ status: "completed", completed: 1, data: [page("https://example.com/")], next: "https://evil.example/v2/crawl/job-1?skip=10" }) }] }));
    const n = await crawl(next);
    expect(n.code).toBe(EXIT.failed);
    expect(n.stderr).toContain("another server (https://evil.example)");
    expect(await hasFolder(n.home)).toBe(false);
  });

  it("stops on a job that disappeared or a status it doesn't know (exit 1)", async () => {
    const gone = await crawlApi(() => ({ polls: [{ status: 404, body: { success: false, code: "NOT_FOUND", error: "crawl job not found (jobs expire after 24 h)" } }] }));
    const r = await crawl(gone);
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toContain("Error: crawl job not found (jobs expire after 24 h)\n");
    await closeApi?.();

    const odd = await crawlApi(() => ({ polls: [{ body: status({ status: "cancelled" }) }] }));
    const o = await crawl(odd);
    expect(o.code).toBe(EXIT.failed);
    expect(o.stderr).toContain('The service\'s answer was unexpected: status "cancelled".');
  });

  it("exits 1 when every page failed, listing why", async () => {
    const failures = Array.from({ length: 12 }, (_, i) => ({ url: `https://example.com/p${i}`, code: "HTTP_ERROR", error: "HTTP 500" }));
    const m = await crawlApi(() => ({ polls: [{ body: status({ status: "completed", completed: 0, total: 0, failed: 12, failures }) }] }));
    const r = await crawl(m);
    expect(r.code).toBe(EXIT.failed);
    expect(r.stdout).toContain("Saved 0 pages");
    expect(r.stdout).toContain("12 pages couldn't be read:\n  - https://example.com/p0 (HTTP_ERROR: HTTP 500)\n");
    expect(r.stdout).toContain("  ...and 2 more, listed in pages.json\n");
    expect(r.stderr).toContain("No page could be read; see the reasons above.\n");
    expect((await manifest(r.folder)).failures).toHaveLength(12);
  });

  it("works with an older server that doesn't report failures, and says so", async () => {
    const old = { success: true, status: "completed", completed: 1, total: 1, creditsUsed: 0, expiresAt: EXPIRES, next: null, data: [page("https://example.com/")] };
    const m = await crawlApi(() => ({ polls: [{ body: old }] }));
    const r = await crawl(m);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("This server doesn't report pages that failed, so some may be missing.\n");
    expect(r.stderr).toContain("  1 of 1 page read\n");
    expect(await manifest(r.folder)).toMatchObject({ failed: null, failures: [] });
  });

  it("names files only from page addresses, numbers clashes and never saves outside the folder", async () => {
    const data = [
      page("https://example.com/a"),
      page("https://example.com/a/"), // same name as the one before
      page("https://example.com/a?x=1"),
      page("https://example.com/..%2F..%2Fetc%2Fpasswd"),
      { markdown: "no address", metadata: { title: "../../escape" } },
      { markdown: "bad address", metadata: { sourceURL: "../../../escape", title: "x" } },
      { markdown: 42, metadata: { sourceURL: "https://example.com/not-text" } }, // not Markdown: skipped
      { metadata: { sourceURL: "https://example.com/missing" } },
      null,
    ];
    const m = await crawlApi(() => ({ polls: [{ body: status({ status: "completed", completed: 6, total: 6, data }) }] }));
    const r = await crawl(m);
    expect(r.code).toBe(EXIT.ok);
    const files = (await manifest(r.folder)).pages.map((p: { file: string }) => p.file);
    expect(files).toEqual(["example.com_a.md", "example.com_a-2.md", expect.stringMatching(/^example\.com_a_[0-9a-f]{8}\.md$/),
      "example.com_etc-passwd.md", "page-5.md", "page-6.md"]);
    expect((await readdir(r.folder)).sort()).toEqual([...files, "pages.json"].sort());
    expect(await readdir(r.home)).toEqual([OUTPUT_DIR]);
  });

  it("prints a JSON summary with --json, and only the folder with --quiet", async () => {
    const m = await crawlApi(() => ({ polls: [{ body: status({ status: "completed", completed: 1, data: [page("https://example.com/")] }) }] }));
    const json = await crawl(m, ["--json"]);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true, command: "crawl", url: "https://example.com/", jobId: "job-1", finished: true,
      folder: json.folder, pages: 1, failed: 0, failures: [], expiresAt: EXPIRES,
    });
    const quiet = await crawl(m, ["-q"]);
    expect(quiet).toMatchObject({ code: EXIT.ok, stdout: `${quiet.folder}\n`, stderr: "" });
  });

  it("checks its options before starting anything (exit 2)", async () => {
    const m = await crawlApi(() => ({ polls: [] }));
    const cases: [string[], string][] = [
      [["--limit", "0"], "--limit must be a whole number from 1 to 100."],
      [["--limit", "101"], "--limit must be a whole number from 1 to 100."],
      [["--limit", "2.5"], "--limit must be a whole number from 1 to 100."],
      [["--depth", "4"], "--depth must be a whole number from 0 to 3."],
      [["--max-wait", "0"], "--max-wait must be a whole number from 1 to 120."],
      [["--format", "links"], '--format doesn\'t work with "crawl".'],
      [["--stdout"], '--stdout doesn\'t work with "crawl".'],
      [["https://example.org/"], "crawl starts from one address (got 2)."],
      [["-o", " "], "--output needs a folder name."],
    ];
    for (const [extra, message] of cases) {
      const r = await crawl(m, extra);
      expect(r.code, extra.join(" ")).toBe(EXIT.usage);
      expect(r.stderr, extra.join(" ")).toContain(`Error: ${message}\n`);
    }
    const none = await run(["crawl"]);
    expect(none).toMatchObject({ code: EXIT.usage, stderr: "Error: Give the address of the website to read.\nFor example: crawler-free crawl https://example.com\n" });
    expect((await run(["crawl", "ftp://example.com/"])).code).toBe(EXIT.usage);
    const scrapeOption = await run(["scrape", "https://example.com/", "--limit", "5"]);
    expect(scrapeOption.stderr).toContain('--limit doesn\'t work with "scrape".');
    expect(m.hits).toEqual([]);
  });
});
