import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_API } from "../src/client";
import { EXIT } from "../src/errors";
import { fileNameFor, OUTPUT_DIR } from "../src/output";
import { mockApi, run, sendJson, type Hit } from "./helpers";

const BOOK: Record<string, string> = { title: "A Light in the Attic", price: "£51.77", availability: "In stock (22 available)" };
const TITLE = "A Light in the Attic | Books to Scrape - Sandbox";
const NOTE = "Facts come from a small AI model and can be wrong: check anything important against the page.\n";

// Answers like POST /v2/scrape with a json format: one value per requested field ("" when the page doesn't have it),
// plus special cases keyed on the page address.
const factsApi = (hit: Hit, res: Parameters<Parameters<typeof mockApi>[0]>[1]) => {
  const { url, formats } = JSON.parse(hit.body || "{}") as { url: string; formats: { schema: { properties: Record<string, unknown> } }[] };
  if (url.includes("limited")) return sendJson(res, 429, { success: false, code: "RATE_LIMITED", error: "You've used all 20 fact look-ups allowed per day. Try again in 5 hours." }, { "retry-after": "18000" });
  if (url.includes("budget")) return sendJson(res, 503, { success: false, code: "EXTRACT_BUDGET_EXHAUSTED", error: "the free daily AI budget is used up; retry after 00:00 UTC" }, { "retry-after": "3600" });
  if (url.includes("failed")) return sendJson(res, 500, { success: false, code: "EXTRACT_FAILED", error: "model output is missing: price" });
  if (url.includes("broken")) return sendJson(res, 200, { success: true, data: { metadata: {} } });
  const evil = url.includes("evil");
  const json = Object.fromEntries(Object.keys(formats[0].schema.properties).map((k) => [k, evil ? "£5\u001b]0;pwned\u0007\u001b[2J" : BOOK[k] ?? ""]));
  const metadata = { title: evil ? "Sale\u001b[31m!" : TITLE, url: url.replace("http:", "https:"), sourceURL: url, statusCode: 200 };
  sendJson(res, 200, { success: true, data: { json, metadata } }, { "x-cache": url.includes("cached") ? "HIT" : "MISS" });
};

let closeApi: (() => Promise<void>) | undefined;
afterEach(async () => { await closeApi?.(); closeApi = undefined; });
const api = async () => { const m = await mockApi(factsApi); closeApi = m.close; return m; };
const PAGE = "https://books.example/catalogue/a-light";
const saved = (home: string, name = "books.example_catalogue_a-light.facts.json") => join(home, OUTPUT_DIR, name);

describe("crawler-free extract", () => {
  it("looks up the named facts, saves them as JSON and shows them", async () => {
    const m = await api();
    const r = await run(["extract", PAGE, "--fields", "title,price", "--api-url", m.url]);
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(m.hits[0].body)).toEqual({
      url: PAGE,
      formats: [{ type: "json", schema: { type: "object", properties: { title: { type: "string" }, price: { type: "string" } } } }],
    });
    const path = saved(r.home);
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify({ title: BOOK.title, price: BOOK.price }, null, 2)}\n`);
    expect(r.stdout).toBe(`Saved 2 facts from "${TITLE}" to ${path}\n  title: ${BOOK.title}\n  price: ${BOOK.price}\n${NOTE}`);
    expect(r.stderr).toBe(`Looking up title, price on ${PAGE} ...\n`); // quota note only for the hosted service
  });

  it("explains the shared AI quota before a look-up on the hosted service", async () => {
    const m = await api();
    const viaMock: typeof fetch = (input, init) => fetch(String(input).replace(DEFAULT_API, m.url), init);
    const r = await run(["extract", PAGE, "--fields", "title"], { fetch: viaMock });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain("Facts are read by a small AI model whose free daily budget everyone shares: 20 fresh look-ups a day per connection. "
      + "The same page and fields again within an hour come from the cache and don't count.\n");
  });

  it("takes field names like the web page: spaces become _, repeats dropped, --fields more than once", async () => {
    const m = await api();
    const r = await run(["extract", PAGE, "--fields", " release date , title", "--fields", "title,release_date,,  ", "--api-url", m.url]);
    expect(r.code).toBe(EXIT.ok);
    expect(Object.keys(JSON.parse(m.hits[0].body).formats[0].schema.properties)).toEqual(["release_date", "title"]);
  });

  it("says which facts came back empty, without failing", async () => {
    const m = await api();
    const r = await run(["extract", PAGE, "--fields", "title,isbn", "--api-url", m.url]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("  isbn: (empty)\nNot found on the page, or the model couldn't tell: isbn\n");
    const json = await run(["extract", PAGE, "--fields", "title,isbn", "--json", "--force", "--api-url", m.url]);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, empty: ["isbn"] });
  });

  it("prints the facts with --stdout, a JSON summary with --json, and only the path with --quiet", async () => {
    const m = await api();
    const out = await run(["extract", PAGE, "--fields", "price", "--stdout", "--api-url", m.url]);
    expect(out.stdout).toBe(`${JSON.stringify({ price: BOOK.price }, null, 2)}\n`);
    expect(out.stderr).toBe(`Looking up price on ${PAGE} ...\nDone: 1 of 1 facts found.\n`);
    expect(await readdir(out.home)).not.toContain(OUTPUT_DIR);

    const json = await run(["extract", `${PAGE}?cached`, "--fields", "title,price", "--json", "--api-url", m.url]);
    expect(json.stderr).toBe("");
    const summary = JSON.parse(json.stdout);
    expect(summary).toEqual({
      ok: true, command: "extract", url: `${PAGE}?cached`, finalUrl: `${PAGE}?cached`, fields: ["title", "price"], savedTo: expect.any(String),
      facts: { title: BOOK.title, price: BOOK.price }, empty: [], cached: true, title: TITLE, warning: null,
    });
    expect(summary.savedTo).toBe(saved(json.home, fileNameFor(new URL(`${PAGE}?cached`), "facts")));
    const quiet = await run(["extract", PAGE, "--fields", "title", "-q", "--api-url", m.url]);
    expect(quiet).toMatchObject({ code: EXIT.ok, stdout: `${saved(quiet.home)}\n`, stderr: "" });
  });

  it("says when the answer came from the cache", async () => {
    const m = await api();
    const r = await run(["extract", `${PAGE}?cached`, "--fields", "title", "--api-url", m.url]);
    expect(r.stdout).toContain("The service answered from its cache, so no look-up was used.\n");
  });

  it("never sends a page's escape sequences to the terminal, but saves the facts exactly", async () => {
    const m = await api();
    const r = await run(["extract", "https://books.example/evil", "--fields", "price", "--api-url", m.url]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(r.stdout).toContain('from "Sale [31m!"');
    expect(r.stdout).toContain("  price: £5 ]0;pwned [2J\n");
    expect(JSON.parse(await readFile(saved(r.home, "books.example_evil.facts.json"), "utf8"))).toEqual({ price: "£5\u001b]0;pwned\u0007\u001b[2J" });
  });

  it("reports limits (exit 4) and failures (exit 1) once, without retrying or creating files", async () => {
    const m = await api();
    const limited = await run(["extract", "https://books.example/limited", "--fields", "title", "--api-url", m.url]);
    expect(limited.code).toBe(EXIT.limit);
    expect(limited.stderr).toContain("Error: You've used all 20 fact look-ups allowed per day. Try again in 5 hours.\nCrawler Free is free and shared");
    const budget = await run(["extract", "https://books.example/budget", "--fields", "title", "--json", "--api-url", m.url]);
    expect(budget.code).toBe(EXIT.limit);
    expect(JSON.parse(budget.stdout).error).toMatchObject({ code: "EXTRACT_BUDGET_EXHAUSTED", retryAfterSeconds: 3600, hint: expect.stringContaining("Reading page text (scrape) still works.") });
    const failed = await run(["extract", "https://books.example/failed", "--fields", "title", "--api-url", m.url]);
    expect(failed).toMatchObject({ code: EXIT.failed, stderr: "Looking up title on https://books.example/failed ...\nError: model output is missing: price\n" });
    const broken = await run(["extract", "https://books.example/broken", "--fields", "title", "--api-url", m.url]);
    expect(broken.code).toBe(EXIT.failed);
    expect(broken.stderr).toContain("The service's answer didn't contain the facts.");
    expect(m.hits).toHaveLength(4);
    for (const r of [limited, budget, failed, broken]) expect(await readdir(r.home)).not.toContain(OUTPUT_DIR);
  });

  it("never replaces a file silently, and decides before the look-up", async () => {
    const m = await api();
    const home = (await run(["--version"])).home;
    const path = saved(home);
    await mkdir(join(home, OUTPUT_DIR), { recursive: true });
    await writeFile(path, "old");
    const kept = await run(["extract", PAGE, "--fields", "title", "--api-url", m.url], { cwd: home });
    expect(kept.code).toBe(EXIT.output);
    expect(m.hits).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("old");
    const forced = await run(["extract", PAGE, "--fields", "title", "--force", "--api-url", m.url], { cwd: home });
    expect(forced.code).toBe(EXIT.ok);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ title: BOOK.title });
  });

  it("saves under a name that never clashes with scrape --format json for the same page", () => {
    const url = new URL(PAGE);
    expect(fileNameFor(url, "facts")).toBe("books.example_catalogue_a-light.facts.json");
    expect(fileNameFor(url, "json")).toBe("books.example_catalogue_a-light.json");
  });

  it("checks the address, the field names and the options before asking the service (exit 2)", async () => {
    const m = await api();
    const cases: [string[], string][] = [
      [[PAGE], "Error: Say which facts to look up with --fields, separated by commas.\nFor example: crawler-free extract "],
      [[PAGE, "--fields", " , ,"], "Say which facts to look up with --fields"],
      [[PAGE, "--fields", Array.from({ length: 21 }, (_, i) => `f${i}`).join(",")], "--fields takes up to 20 names (got 21)."],
      [[PAGE, "--fields", "x".repeat(61)], `Each field name can be up to 60 characters ("${"x".repeat(23)}…" has 61).`],
      [["--fields", "title"], "Give the address of the page to look up."],
      [[PAGE, "https://other.example/", "--fields", "title"], "extract reads one page at a time (got 2 addresses)."],
      [["ftp://books.example/", "--fields", "title"], "Only http:// and https:// pages can be read"],
      [[PAGE, "--fields", "title", "--stdout", "--json"], "--stdout and --json both print to stdout"],
      [[PAGE, "--fields", "title", "--format", "json"], '--format doesn\'t work with "extract".'],
      [[PAGE, "--fields", "title", "--limit", "5"], '--limit doesn\'t work with "extract".'],
    ];
    for (const [extra, message] of cases) {
      const r = await run(["extract", ...extra, "--api-url", m.url]);
      expect(r.code, extra.join(" ")).toBe(EXIT.usage);
      expect(r.stderr + r.stdout, extra.join(" ")).toContain(message); // --json puts the error on stdout
    }
    expect((await run(["scrape", PAGE, "--fields", "title", "--api-url", m.url])).stderr).toContain('--fields doesn\'t work with "scrape".');
    expect(m.hits).toEqual([]);
  });
});
