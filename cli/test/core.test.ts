import { readFile, stat } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/args";
import { checkApiUrl, configPath, readConfig, resetConfig, resolveApiUrl, writeConfig, type System } from "../src/config";
import { DEFAULT_API } from "../src/client";
import { CliError, EXIT, fromApi } from "../src/errors";
import { VERSION } from "../src/version";
import { printable } from "../src/ui";
import { tempDir } from "./helpers";

describe("arguments", () => {
  it("reads the command, its words and the shared options", () => {
    expect(parse(["doctor", "--json", "-q", "--api-url", "http://localhost:8787", "--timeout", "5"])).toEqual({
      command: "doctor", rest: [], help: false, version: false, json: true, quiet: true, apiUrl: "http://localhost:8787", timeoutMs: 5000,
      format: undefined, output: undefined, stdout: false, force: false, hosted: false, reset: false,
    });
    expect(parse(["scrape", "example.com", "-f", "links", "-o", "out/", "--force"])).toMatchObject({
      command: "scrape", rest: ["example.com"], format: "links", output: "out/", force: true, stdout: false,
    });
    expect(parse(["extract", "example.com", "--fields", "title,price", "--fields", "release date"]).fields).toEqual(["title,price", "release date"]);
    expect(parse(["setup", "--hosted"])).toMatchObject({ command: "setup", hosted: true, reset: false });
    expect(parse(["-v"]).version).toBe(true);
    expect(parse([]).command).toBeUndefined();
  });

  it("rejects unknown options and bad timeouts as usage errors (exit 2)", () => {
    for (const argv of [["doctor", "--nope"], ["--timeout", "0"], ["--timeout", "1.5"], ["--timeout", "4000"], ["--timeout", "soon"]]) {
      expect(() => parse(argv), argv.join(" ")).toThrow(CliError);
      try { parse(argv); } catch (e) { expect((e as CliError).exitCode).toBe(EXIT.usage); }
    }
    try { parse(["--nope"]); } catch (e) { expect((e as Error).message).toBe("Unknown option '--nope'."); }
  });
});

describe("errors from the API", () => {
  it("map every API error code to a documented exit code", () => {
    const cases: [number, string, number][] = [
      [400, "BAD_REQUEST", EXIT.usage], [400, "URL_BLOCKED", EXIT.refused], [403, "ROBOTS_DISALLOWED", EXIT.refused], [403, "BLOCKED", EXIT.refused],
      [404, "NOT_FOUND", EXIT.failed], [408, "SCRAPE_TIMEOUT", EXIT.network], [429, "RATE_LIMITED", EXIT.limit],
      [503, "DAILY_BUDGET_EXHAUSTED", EXIT.limit], [503, "EXTRACT_BUDGET_EXHAUSTED", EXIT.limit], [503, "RENDER_BUDGET_EXHAUSTED", EXIT.limit],
      [503, "RENDER_BUSY", EXIT.limit], [503, "DISABLED", EXIT.failed], [500, "SCRAPE_FAILED", EXIT.failed], [500, "EXTRACT_FAILED", EXIT.failed],
      [500, "UNKNOWN_ERROR", EXIT.failed], [403, "CROSS_SITE_BLOCKED", EXIT.failed], [413, "PAYLOAD_TOO_LARGE", EXIT.failed],
    ];
    for (const [status, code, exit] of cases) expect(fromApi(status, code, "m").exitCode, code).toBe(exit);
    expect(fromApi(429, "RATE_LIMITED", "Try again in 5 minutes.", 300)).toMatchObject({ message: "Try again in 5 minutes.", retryAfter: 300 });
    expect(fromApi(502, "HTTP_502", "").message).toBe("The server answered HTTP 502.");
  });

  it("explain each kind of limit, and ignore codes that only look like known ones", () => {
    expect(fromApi(503, "EXTRACT_BUDGET_EXHAUSTED", "m").hint).toBe("The AI model's free daily budget is shared by everyone and resets at 00:00 UTC. Reading page text (scrape) still works.");
    expect(fromApi(503, "RENDER_BUSY", "m").hint).toContain("one page every 10 seconds");
    expect(fromApi(503, "DAILY_BUDGET_EXHAUSTED", "m").hint).toContain("resets at 00:00 UTC");
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(fromApi(400, code, "m"), code).toMatchObject({ exitCode: EXIT.failed, hint: undefined });
    }
  });
});

describe("text from web pages shown in a terminal", () => {
  it("loses control characters, escape sequences and direction overrides, and long values are shortened", () => {
    expect(printable("Title\u001b]0;pwned\u0007 here\u001b[2J")).toBe("Title ]0;pwned here [2J");
    expect(printable("a\r\nb\tc\u009bd‮evil⁦x")).toBe("a b c d evil x");
    expect(printable("£19.99 — café")).toBe("£19.99 — café");
    expect(printable("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("settings", () => {
  const home = "/home/ada";
  it("live in each system's usual settings folder", () => {
    expect(configPath({ platform: "win32", env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" }, homedir: "C:\\Users\\Ada" }))
      .toBe(win32.join("C:\\Users\\Ada\\AppData\\Roaming", "crawler-free", "config.json"));
    expect(configPath({ platform: "win32", env: {}, homedir: "C:\\Users\\Ada" })).toBe(win32.join("C:\\Users\\Ada", "AppData", "Roaming", "crawler-free", "config.json"));
    expect(configPath({ platform: "darwin", env: {}, homedir: "/Users/ada" })).toBe("/Users/ada/Library/Application Support/crawler-free/config.json");
    expect(configPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" }, homedir: home })).toBe(posix.join("/xdg", "crawler-free", "config.json"));
    expect(configPath({ platform: "linux", env: {}, homedir: home })).toBe("/home/ada/.config/crawler-free/config.json");
  });

  it("only accept https service addresses (plain http only for this computer), without credentials, query or fragment", () => {
    expect(checkApiUrl("https://crawler-free.crawler-free.workers.dev/")).toBe(DEFAULT_API);
    expect(checkApiUrl("https://example.com/api//")).toBe("https://example.com/api");
    for (const local of ["http://localhost:8787", "http://127.0.0.1:8788", "http://127.8.9.10", "http://[::1]:8787", "http://dev.localhost:3000"]) {
      expect(checkApiUrl(local), local).toBe(local);
    }
    const bad = ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com", "https://example.com/?k=1",
      "https://example.com/#x", "example.com", "", "http://example.com", "http://192.168.1.5:8787", "http://10.0.0.1",
      "http://127.0.0.1.nip.io", "http://localhost.example.com", "http://[::ffff:127.0.0.1]", "http://0.0.0.0"];
    for (const b of bad) expect(() => checkApiUrl(b), b).toThrow(CliError);
    expect(() => checkApiUrl("http://example.com")).toThrow(expect.objectContaining({
      message: "The service address must start with https:// (got http://example.com).",
      hint: "Plain http:// is only allowed for a copy running on this computer (localhost or 127.0.0.1).",
    }));
  });

  it("refuse a settings file or environment variable that names a remote http:// service", async () => {
    const s = await sys();
    const path = await writeConfig(s, { apiUrl: "https://my.example", mode: "self-hosted" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ mode: "self-hosted", apiUrl: "http://my.example" }));
    await expect(readConfig(s)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const env = await sys();
    env.env.CRAWLER_FREE_API_URL = "http://my.example";
    await expect(resolveApiUrl(undefined, env)).rejects.toMatchObject({ code: "BAD_API_URL", exitCode: EXIT.usage });
  });

  const sys = async (): Promise<System> => {
    const dir = await tempDir();
    return { platform: process.platform, env: { APPDATA: join(dir, "AppData"), XDG_CONFIG_HOME: join(dir, ".config") }, homedir: dir };
  };

  it("are written, read back and reset; only the mode and your own service's address are kept", async () => {
    const s = await sys();
    expect(await readConfig(s)).toBeNull();
    const path = await writeConfig(s, { apiUrl: "https://my.example/", mode: "self-hosted" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ apiUrl: "https://my.example", mode: "self-hosted" });
    expect(await readConfig(s)).toEqual({ apiUrl: "https://my.example", mode: "self-hosted" });
    // Hosted saves no address, so the choice follows the address built into the CLI.
    await writeConfig(s, { apiUrl: DEFAULT_API, mode: "hosted" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mode: "hosted" });
    expect(await readConfig(s)).toEqual({ apiUrl: DEFAULT_API, mode: "hosted" });
    await writeConfig(s, { apiUrl: `${DEFAULT_API}/`, mode: "self-hosted" }); // the hosted address is the hosted mode
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mode: "hosted" });
    await resetConfig(s);
    expect(await readConfig(s)).toBeNull();
    await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" }); // the empty folder goes too
    await resetConfig(s); // resetting twice is fine

    await writeConfig(s, { apiUrl: DEFAULT_API, mode: "hosted" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dirname(path), "notes.txt"), "mine");
    await resetConfig(s);
    expect(await readFile(join(dirname(path), "notes.txt"), "utf8")).toBe("mine"); // a folder with other files stays
  });

  it("report a broken settings file with its path and how to fix it (exit 2)", async () => {
    const s = await sys();
    const path = await writeConfig(s, { apiUrl: DEFAULT_API, mode: "hosted" });
    const { writeFile } = await import("node:fs/promises");
    for (const text of ["{not json", "[]", "{}", "null", '{"apiUrl":"ftp://x"}', '{"apiUrl":"https://u:p@x.example"}',
      '{"mode":"cloud","apiUrl":"https://x.example"}', `{"mode":"hosted","apiUrl":"https://other.example"}`]) {
      await writeFile(path, text);
      const err = await readConfig(s).catch((e: CliError) => e);
      expect(err, text).toMatchObject({ code: "CONFIG_INVALID", exitCode: EXIT.usage });
      expect((err as CliError).hint).toContain(path);
    }
  });

  it("choose the service address: --api-url, then CRAWLER_FREE_API_URL, then the settings file, then the hosted service", async () => {
    const s = await sys();
    expect(await resolveApiUrl(undefined, s)).toEqual({ url: DEFAULT_API, source: "hosted service (default)" });
    await writeConfig(s, { apiUrl: "https://saved.example", mode: "self-hosted" });
    expect((await resolveApiUrl(undefined, s)).url).toBe("https://saved.example");
    s.env.CRAWLER_FREE_API_URL = "https://env.example/";
    expect(await resolveApiUrl(undefined, s)).toEqual({ url: "https://env.example", source: "CRAWLER_FREE_API_URL" });
    expect(await resolveApiUrl("http://localhost:8787", s)).toEqual({ url: "http://localhost:8787", source: "--api-url" });
  });
});

it("the version matches cli/package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(VERSION).toBe(pkg.version);
});
