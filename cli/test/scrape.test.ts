import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/errors";
import { fileNameFor, OUTPUT_DIR } from "../src/output";
import { mockApi, run, sendJson, type Hit } from "./helpers";

const PAGE = {
  markdown: "# Example Domain\n\nThis domain is for use in documentation examples.",
  links: ["https://example.com/a", "https://iana.org/domains/example"],
  metadata: { title: "Example Domain", url: "https://example.com/", sourceURL: "https://example.com/", statusCode: 200 },
};

// Answers like POST /v2/scrape: only the requested formats, plus special cases keyed on the page address.
const scrapeApi = (hit: Hit, res: Parameters<Parameters<typeof mockApi>[0]>[1]) => {
  const { url, formats } = JSON.parse(hit.body || "{}") as { url: string; formats: string[] };
  if (url.includes("169.254")) return sendJson(res, 400, { success: false, code: "URL_BLOCKED", error: "IP-literal hosts are not allowed" });
  if (url.includes("limited")) return sendJson(res, 429, { success: false, code: "RATE_LIMITED", error: "You've used all 20 page reads allowed per minute. Try again in 30 seconds." }, { "retry-after": "30" });
  if (url.includes("broken")) return sendJson(res, 200, { success: true, data: { metadata: {} } });
  const data: Record<string, unknown> = { metadata: PAGE.metadata };
  if (formats.includes("markdown")) data.markdown = url.includes("empty") ? "" : PAGE.markdown;
  if (formats.includes("links")) data.links = url.includes("empty") ? [] : PAGE.links;
  if (url.includes("warn")) data.warning = "ignored unsupported fields: x";
  sendJson(res, 200, { success: true, data }, { "x-cache": url.includes("cached") ? "HIT" : "MISS" });
};

let closeApi: (() => Promise<void>) | undefined;
afterEach(async () => { await closeApi?.(); closeApi = undefined; });
const api = async () => { const m = await mockApi(scrapeApi); closeApi = m.close; return m; };
const exists = (p: string) => readFile(p).then(() => true, () => false);

describe("crawler-free scrape", () => {
  it("saves readable Markdown in ./crawler-free-output and says where", async () => {
    const m = await api();
    const r = await run(["scrape", "https://example.com/docs/intro", "--api-url", m.url]);
    const path = join(r.home, OUTPUT_DIR, "example.com_docs_intro.md");
    expect(r.code).toBe(0);
    expect(await readFile(path, "utf8")).toBe(`${PAGE.markdown}\n`);
    expect(r.stdout).toBe(`Saved Markdown (${PAGE.markdown.length} characters from "Example Domain") to ${path}\n`);
    expect(r.stderr).toBe("Reading https://example.com/docs/intro ...\n");
    expect(JSON.parse(m.hits[0].body)).toEqual({ url: "https://example.com/docs/intro", formats: ["markdown"] });
  });

  it("treats a bare host as https, like the web page", async () => {
    const m = await api();
    const r = await run(["scrape", "example.com", "--api-url", m.url]);
    expect(r.code).toBe(0);
    expect(JSON.parse(m.hits[0].body).url).toBe("https://example.com/");
    expect(await exists(join(r.home, OUTPUT_DIR, "example.com.md"))).toBe(true);
  });

  it("saves links one per line, or the whole answer as JSON", async () => {
    const m = await api();
    const links = await run(["scrape", "https://example.com/", "--format", "links", "--api-url", m.url]);
    expect(await readFile(join(links.home, OUTPUT_DIR, "example.com.txt"), "utf8")).toBe(`${PAGE.links.join("\n")}\n`);
    expect(links.stdout).toContain("Saved links (2 links");
    expect(JSON.parse(m.hits[0].body).formats).toEqual(["links"]);

    const json = await run(["scrape", "https://example.com/", "-f", "json", "--api-url", m.url]);
    expect(JSON.parse(await readFile(join(json.home, OUTPUT_DIR, "example.com.json"), "utf8"))).toEqual(PAGE);
    expect(JSON.parse(m.hits[1].body).formats).toEqual(["markdown", "links"]);
  });

  it("prints to stdout with --stdout (progress stays on stderr, nothing saved)", async () => {
    const m = await api();
    const r = await run(["scrape", "https://example.com/", "--stdout", "--api-url", m.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${PAGE.markdown}\n`);
    expect(r.stderr).toBe(`Reading https://example.com/ ...\nDone: ${PAGE.markdown.length} characters.\n`);
    expect(await readdir(r.home)).not.toContain(OUTPUT_DIR);
    const quiet = await run(["scrape", "https://example.com/", "--stdout", "-q", "--api-url", m.url]);
    expect(quiet).toMatchObject({ stdout: `${PAGE.markdown}\n`, stderr: "" });
  });

  it("prints a JSON summary with --json, and only the path with --quiet", async () => {
    const m = await api();
    const r = await run(["scrape", "https://example.com/cached", "--json", "--api-url", m.url]);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true, command: "scrape", url: "https://example.com/cached", finalUrl: "https://example.com/", format: "markdown",
      savedTo: join(r.home, OUTPUT_DIR, "example.com_cached.md"), characters: PAGE.markdown.length, cached: true, title: "Example Domain", warning: null,
    });
    const q = await run(["scrape", "https://example.com/", "-q", "--api-url", m.url]);
    expect(q).toMatchObject({ code: 0, stdout: `${join(q.home, OUTPUT_DIR, "example.com.md")}\n`, stderr: "" });
  });

  it("never replaces a file silently: stops in scripts, asks a person, replaces only with --force or a yes", async () => {
    const m = await api();
    const first = await run(["scrape", "https://example.com/", "--api-url", m.url]);
    const path = join(first.home, OUTPUT_DIR, "example.com.md");
    await writeFile(path, "my notes");
    const env = { APPDATA: join(first.home, "AppData"), XDG_CONFIG_HOME: join(first.home, ".config") };
    const again = { env, homedir: first.home, cwd: first.home };

    const reads = m.hits.length;
    const script = await run(["scrape", "https://example.com/", "--api-url", m.url], again);
    expect(script.code).toBe(EXIT.output);
    expect(script.stderr).toBe(`Error: ${path} already exists.\nUse --force to replace it, or --output to choose another name.\n`);
    expect(await readFile(path, "utf8")).toBe("my notes");

    const questions: string[] = [];
    const no = await run(["scrape", "https://example.com/", "--api-url", m.url], { ...again, ask: async (q) => { questions.push(q); return ""; } });
    expect(no.code).toBe(EXIT.output);
    expect(no.stderr).toContain(`Kept the existing file ${path}; nothing was read or saved.`);
    expect(questions).toEqual([`${path} already exists. Replace it? [y/N] `]);
    expect(await readFile(path, "utf8")).toBe("my notes");

    const asJson = await run(["scrape", "https://example.com/", "--json", "--api-url", m.url], { ...again, ask: async () => { questions.push("asked"); return "y"; } });
    expect(asJson.code).toBe(EXIT.output); // --json never asks
    expect(questions).toHaveLength(1);
    expect(m.hits.length).toBe(reads); // refusing to overwrite happens before reading, so it costs no quota

    const yes = await run(["scrape", "https://example.com/", "--api-url", m.url], { ...again, ask: async () => "Y" });
    expect(yes.code).toBe(0);
    expect(await readFile(path, "utf8")).toBe(`${PAGE.markdown}\n`);

    await writeFile(path, "my notes");
    expect((await run(["scrape", "https://example.com/", "--force", "--api-url", m.url], again)).code).toBe(0);
    expect(await readFile(path, "utf8")).toBe(`${PAGE.markdown}\n`);
  });

  it("saves to --output: a file (creating folders), an existing folder, or a folder ending in /", async () => {
    const m = await api();
    const file = await run(["scrape", "https://example.com/", "-o", join("notes", "deep", "page.md"), "--api-url", m.url]);
    expect(await readFile(join(file.home, "notes", "deep", "page.md"), "utf8")).toBe(`${PAGE.markdown}\n`);

    const home = file.home;
    await mkdir(join(home, "existing"));
    const env = { APPDATA: join(home, "AppData"), XDG_CONFIG_HOME: join(home, ".config") };
    expect((await run(["scrape", "https://example.com/", "-o", "existing", "--api-url", m.url], { env, homedir: home, cwd: home })).code).toBe(0);
    expect(await exists(join(home, "existing", "example.com.md"))).toBe(true);
    expect((await run(["scrape", "https://example.com/", "-o", "fresh/", "--api-url", m.url], { env, homedir: home, cwd: home })).code).toBe(0);
    expect(await exists(join(home, "fresh", "example.com.md"))).toBe(true);

    await writeFile(join(home, "a-file"), "x");
    const blocked = await run(["scrape", "https://example.com/", "-o", join("a-file", "page.md"), "--api-url", m.url], { env, homedir: home, cwd: home });
    expect(blocked.code).toBe(EXIT.output);
    expect(blocked.stderr).toContain("Couldn't save");
  });

  it("passes the service's refusals and limits through with their exit codes, saving nothing", async () => {
    const m = await api();
    const refused = await run(["scrape", "http://169.254.169.254/latest/meta-data/", "--api-url", m.url]);
    expect(refused.code).toBe(EXIT.refused);
    expect(refused.stderr).toBe("Reading http://169.254.169.254/latest/meta-data/ ...\nError: IP-literal hosts are not allowed\n"
      + "Crawler Free only reads public web addresses: not local, private or IP-address hosts.\n");
    expect(await readdir(refused.home)).not.toContain(OUTPUT_DIR);

    const limited = await run(["scrape", "https://example.com/limited", "--api-url", m.url]);
    expect(limited.code).toBe(EXIT.limit);
    expect(limited.stderr).toContain("Try again in 30 seconds.");
    const asJson = JSON.parse((await run(["scrape", "https://example.com/limited", "--json", "--api-url", m.url])).stdout);
    expect(asJson).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", exitCode: EXIT.limit, retryAfterSeconds: 30 } });
    expect(m.hits).toHaveLength(3); // each refusal was one request: nothing is retried automatically
  });

  it("checks the address and options before contacting the service (exit 2)", async () => {
    const m = await api();
    const cases: [string[], string][] = [
      [["scrape"], "Give the address of the page to read."],
      [["scrape", "ftp://example.com/file"], "Only http:// and https:// pages can be read (got ftp:)."],
      [["scrape", "https://user:secret@example.com/"], "Addresses with a user name or password can't be read."],
      [["scrape", "https://a.example/", "https://b.example/"], "scrape reads one page at a time (got 2 addresses)."],
      [["scrape", "https://example.com/", "--format", "pdf"], 'Unknown format "pdf". Choose markdown, links or json.'],
      [["scrape", "https://example.com/", "--stdout", "--json"], "--stdout and --json both print to stdout; use one of them."],
      [["scrape", "https://example.com/", "--stdout", "-o", "x.md"], "--stdout and --output can't be used together."],
      [["scrape", "https://example.com/", "-o", " "], "--output needs a file or folder name."],
    ];
    for (const [argv, message] of cases) {
      const r = await run([...argv, "--api-url", m.url]);
      expect(r.code, argv.join(" ")).toBe(EXIT.usage);
      if (argv.includes("--json")) expect(JSON.parse(r.stdout).error.message).toBe(message); // --json reports errors on stdout
      else expect(r.stderr, argv.join(" ")).toContain(`Error: ${message}`);
      expect(r.stderr + r.stdout).not.toContain("secret");
    }
    expect(m.hits.length).toBeLessThanOrEqual(1); // only the empty --output case gets as far as the service
  });

  it("notes warnings, empty pages and the cache; rejects answers without the page", async () => {
    const m = await api();
    const warn = await run(["scrape", "https://example.com/warn", "--api-url", m.url]);
    expect(warn.stderr).toContain("Note: ignored unsupported fields: x");
    const empty = await run(["scrape", "https://example.com/empty", "--api-url", m.url]);
    expect(empty.code).toBe(0);
    expect(empty.stderr).toContain("Note: the page had no readable text.");
    expect(await readFile(join(empty.home, OUTPUT_DIR, "example.com_empty.md"), "utf8")).toBe("");
    const cached = await run(["scrape", "https://example.com/cached", "--api-url", m.url]);
    expect(cached.stdout).toContain("The service answered from its cache (pages are cached for 1 hour).");
    const broken = await run(["scrape", "https://example.com/broken", "--api-url", m.url]);
    expect(broken.code).toBe(EXIT.failed);
    expect(broken.stderr).toContain("The service's answer didn't contain the page.");
    expect(await readdir(broken.home)).not.toContain(OUTPUT_DIR);
  });

  it("uses the service address from CRAWLER_FREE_API_URL", async () => {
    const m = await api();
    const r = await run(["scrape", "https://example.com/", "--stdout"], { env: { CRAWLER_FREE_API_URL: m.url } });
    expect(r.code).toBe(0);
    expect(m.hits).toHaveLength(1);
  });
});

describe("file names from addresses", () => {
  const name = (u: string, f: "markdown" | "links" | "json" = "markdown") => fileNameFor(new URL(u), f);
  it("are readable, predictable and safe", () => {
    expect(name("https://Example.COM/")).toBe("example.com.md");
    expect(name("https://example.com/Docs/Getting%20Started/")).toBe("example.com_docs_getting-started.md");
    expect(name("https://example.com/a/../../etc/passwd")).toBe("example.com_etc_passwd.md");
    expect(name("https://example.com/%2e%2e%2f%2e%2e%2fwin.ini")).toBe("example.com_win.ini.md");
    expect(name("https://example.com:8443/x", "links")).toBe("example.com-8443_x.txt");
    expect(name("https://example.com/search?q=1")).toMatch(/^example\.com_search_[0-9a-f]{8}\.md$/);
    expect(name("https://example.com/search?q=1")).not.toBe(name("https://example.com/search?q=2"));
    expect(name("https://example.com/con")).toBe("example.com_con.md");
    expect(name("https://xn--bcher-kva.example/ü")).toBe("xn--bcher-kva.example.md");
    const long = name(`https://example.com/${"segment/".repeat(40)}`);
    expect(long.length).toBeLessThanOrEqual(123);
    for (const u of ["https://example.com/a\\b", "https://example.com/.hidden", "https://example.com/trailing./", "https://example.com/<>:\"|?*"]) {
      const n = name(u);
      expect(n, u).toMatch(/^[a-z0-9][a-z0-9._-]*\.md$/);
      expect(n, u).not.toMatch(/\.\.|[\\/]|[. ]\.md$/);
    }
  });
});

it("never runs shell commands or evaluates code (security regression)", async () => {
  const dir = new URL("../src/", import.meta.url);
  for (const f of await readdir(dir)) {
    const src = await readFile(new URL(f, dir), "utf8");
    expect(src, f).not.toMatch(/child_process|\beval\s*\(|new Function\s*\(|\bexecSync\b|\bspawn\s*\(/);
  }
});
