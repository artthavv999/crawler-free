import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_API } from "../src/client";
import { EXIT } from "../src/errors";
import { documentsFolder, RESULTS_FOLDER } from "../src/places";
import { mockApi, run, sendJson, tempDir, type Hit } from "./helpers";

// The guided menu (docs/beginner-cli-plan.md, Phase B): `crawler-free` with nothing after it, with a person at a
// terminal. Answers are scripted; requests for the hosted service go to a local mock.
let closeApi: (() => Promise<void>) | undefined;
afterEach(async () => { await closeApi?.(); closeApi = undefined; });

async function api() {
  const m = await mockApi((hit: Hit, res) => {
    if (hit.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Crawler Free</title>"); return; }
    if (hit.url.startsWith("/v2/crawl/00000000")) return sendJson(res, 404, { success: false, code: "NOT_FOUND", error: "no such job" });
    if (hit.url === "/v2/scrape") {
      const { url, formats } = JSON.parse(hit.body) as { url: string; formats: unknown[] };
      if (typeof formats[0] === "object") return sendJson(res, 200, { success: true, data: { json: { title: "Hello", price: "£1" }, metadata: { title: "Hello", url } } });
      return sendJson(res, 200, { success: true, data: { markdown: "# Hello", links: ["https://example.com/a"], metadata: { title: "Hello", url } } });
    }
    if (hit.method === "POST" && hit.url === "/v2/crawl") return sendJson(res, 200, { success: true, id: "job-1", url: `${DEFAULT_API}/v2/crawl/job-1` }); // the CLI is talking to the hosted address
    if (hit.url.startsWith("/v2/crawl/job-1")) {
      return sendJson(res, 200, { success: true, status: "completed", completed: 1, total: 1, failed: 0, next: null, data: [{ markdown: "# Page", metadata: { sourceURL: "https://books.example/", title: "Page" } }] });
    }
    sendJson(res, 404, { success: false, code: "NOT_FOUND", error: "no route" });
  });
  closeApi = m.close;
  return m;
}

// A computer with a Documents folder, scripted answers, and a folder opener that records what it was asked to open.
async function person(m: { url: string }, ...answers: string[]) {
  const home = await tempDir();
  await mkdir(join(home, "Documents"));
  const work = join(home, "work");
  await mkdir(work);
  const questions: string[] = [];
  const opened: string[] = [];
  const over = {
    homedir: home, cwd: work, stdoutIsTTY: true,
    env: { APPDATA: join(home, "AppData"), XDG_CONFIG_HOME: join(home, ".config") },
    fetch: ((input: unknown, init?: RequestInit) => fetch(String(input).replace(DEFAULT_API, m.url), init)) as typeof fetch,
    clock: { sleep: async () => {}, now: () => 0 },
    ask: async (q: string) => { questions.push(q); return answers.shift() ?? ""; },
    openFolder: async (dir: string) => { opened.push(dir); return true; },
  };
  return { home, work, questions, opened, documents: join(home, "Documents", RESULTS_FOLDER), over, left: () => answers.length };
}

describe("crawler-free with nothing after it", () => {
  it("shows the menu at a terminal; pressing Enter at each question reads one page into Documents/Crawler Free", async () => {
    const m = await api();
    const p = await person(m, "", "example.com", "", "", "");
    const r = await run([], p.over);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain("It uses the free hosted Crawler Free service, so there's nothing to install or sign up for.");
    expect(p.questions[0]).toBe("What would you like to do?\n  1  Read one web page (recommended)\n  2  Read a whole website\n  3  Look up facts on a page\n"
      + "  4  Check or change the setup\n  5  Help and examples\nChoose 1-5 [1]: ");
    expect(p.questions[3]).toContain(`  1  ${p.documents} (recommended)\n  2  This folder: ${join(p.work, "crawler-free-output")}\n  3  Another folder`);
    expect(await readFile(join(p.documents, "example.com.md"), "utf8")).toBe("# Hello\n");
    expect(r.stdout).toContain(`to ${join(p.documents, "example.com.md")}`); // the full path is printed
    expect(JSON.parse(m.hits.find((h) => h.url === "/v2/scrape")!.body)).toEqual({ url: "https://example.com/", formats: ["markdown"] });
    expect(p.questions.at(-1)).toBe("\nWhat next?\n  1  Open the folder\n  2  Do something else\n  3  Exit\nChoose 1-3 [3]: ");
    expect(p.opened).toEqual([]); // only when asked
  });

  it("opens the folder when asked, then offers only the other choices", async () => {
    const m = await api();
    const p = await person(m, "1", "example.com", "2", "1", "1", "");
    const r = await run([], p.over);
    expect(r.code).toBe(EXIT.ok);
    expect(p.opened).toEqual([p.documents]);
    expect(r.stderr).toContain(`Opened ${p.documents}\n`);
    expect(await readFile(join(p.documents, "example.com.txt"), "utf8")).toBe("https://example.com/a\n");
    expect(p.questions.at(-1)).toBe("\nWhat next?\n  1  Do something else\n  2  Exit\nChoose 1-2 [2]: ");
  });

  it("saves into this folder or a typed one when chosen", async () => {
    const m = await api();
    const here = await person(m, "1", "example.com", "", "2", "");
    expect((await run([], here.over)).code).toBe(EXIT.ok);
    expect(await readdir(join(here.work, "crawler-free-output"))).toEqual(["example.com.md"]);
    const typed = await person(m, "1", "example.com", "", "3", "my results ü", "");
    expect((await run([], typed.over)).code).toBe(EXIT.ok);
    expect(await readdir(resolve(typed.work, "my results ü"))).toEqual(["example.com.md"]);
  });

  it("reads a whole website and looks up facts, as the crawl and extract commands do", async () => {
    const m = await api();
    const site = await person(m, "2", "books.example", "5", "2", "");
    expect((await run([], site.over)).code).toBe(EXIT.ok);
    expect(JSON.parse(m.hits.find((h) => h.url === "/v2/crawl")!.body)).toEqual({ url: "https://books.example/", limit: 5, maxDiscoveryDepth: 2 });
    expect((await readdir(join(site.work, "crawler-free-output", "books.example-crawl"))).sort()).toEqual(["books.example.md", "pages.json"]);

    const facts = await person(m, "3", "example.com", "title, price", "2", "");
    expect((await run([], facts.over)).code).toBe(EXIT.ok);
    const ask = JSON.parse(m.hits.filter((h) => h.url === "/v2/scrape").at(-1)!.body);
    expect(Object.keys(ask.formats[0].schema.properties)).toEqual(["title", "price"]);
    expect(JSON.parse(await readFile(join(facts.work, "crawler-free-output", "example.com.facts.json"), "utf8"))).toEqual({ title: "Hello", price: "£1" });
  });

  it("checks the setup with doctor, and changes it only if asked", async () => {
    const m = await api();
    const p = await person(m, "4", "", "");
    const r = await run([], p.over);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Everything looks ready.");
    expect(p.questions).toContain("\nChange which Crawler Free service this computer uses? [y/N] ");
    expect(p.questions.at(-1)).toBe("\nWhat next?\n  1  Do something else\n  2  Exit\nChoose 1-2 [2]: "); // nothing to open
  });

  it("goes back to the menu for something else, and shows help", async () => {
    const m = await api();
    const p = await person(m, "1", "example.com", "", "2", "2", "5");
    const r = await run([], p.over);
    expect(r.code).toBe(EXIT.ok);
    expect(p.questions.filter((q) => q.startsWith("What would you like to do?"))).toHaveLength(2);
    expect(r.stdout).toContain("Usage\n  crawler-free <command> [options]");
  });

  it("asks again after an unusable address, saying why", async () => {
    const m = await api();
    const p = await person(m, "1", "ftp://example.com", "example.com", "", "2", "");
    expect((await run([], p.over)).code).toBe(EXIT.ok);
    expect(p.questions[2]).toBe("Only http:// and https:// pages can be read (got ftp:). Web page address (for example example.com): ");
  });

  it("stops after three unclear answers, and when input has ended (exit 2)", async () => {
    const m = await api();
    const unclear = await person(m, "9", "x", "0");
    const r = await run([], unclear.over);
    expect(r).toMatchObject({ code: EXIT.usage, stderr: expect.stringContaining("Error: No usable answer was given, so nothing was done.") });
    const ended = await person(m); // every answer is empty, as after Ctrl+D
    expect((await run([], ended.over)).code).toBe(EXIT.usage);
    expect(m.hits.filter((h) => h.url === "/v2/scrape")).toEqual([]);
  });

  it("isn't shown to scripts: without a terminal on stdout, or with anything after the command", async () => {
    const m = await api();
    const piped = await person(m, "1");
    const r = await run([], { ...piped.over, stdoutIsTTY: false });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("Usage\n  crawler-free <command> [options]");
    expect(piped.questions).toEqual([]);
    const flagged = await person(m, "1");
    expect((await run(["--quiet"], flagged.over)).code).toBe(EXIT.usage);
    expect(flagged.questions).toEqual([]);
    const noTerminal = await run([], { stdoutIsTTY: true }); // no ask: stdin or stderr isn't a terminal
    expect(noTerminal.code).toBe(EXIT.usage);
  });
});

describe("the Documents folder", () => {
  it("is the one in the home folder, or the home folder itself when there's none", async () => {
    const home = await tempDir();
    const sys = { platform: process.platform, env: {}, homedir: home };
    expect(await documentsFolder(sys)).toBe(home);
    await mkdir(join(home, "Documents"));
    expect(await documentsFolder(sys)).toBe(join(home, "Documents"));
  });

  it.runIf(process.platform === "win32")("on Windows, is OneDrive's when OneDrive keeps Documents", async () => {
    const home = await tempDir();
    await mkdir(join(home, "Documents"));
    await mkdir(join(home, "OneDrive", "Documents"), { recursive: true });
    expect(await documentsFolder({ platform: "win32", env: { OneDrive: join(home, "OneDrive") }, homedir: home })).toBe(join(home, "OneDrive", "Documents"));
  });

  it.runIf(process.platform === "linux")("on Linux, follows XDG_DOCUMENTS_DIR", async () => {
    const home = await tempDir();
    await mkdir(join(home, ".config"));
    await mkdir(join(home, "Dokumente"));
    await writeFile(join(home, ".config", "user-dirs.dirs"), 'XDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOCUMENTS_DIR="$HOME/Dokumente"\n');
    expect(await documentsFolder({ platform: "linux", env: {}, homedir: home })).toBe(join(home, "Dokumente"));
  });
});
