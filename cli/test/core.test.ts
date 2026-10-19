import { readFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/args";
import { checkApiUrl, configPath, readConfig, resetConfig, resolveApiUrl, writeConfig, type System } from "../src/config";
import { DEFAULT_API } from "../src/client";
import { CliError, EXIT, fromApi } from "../src/errors";
import { VERSION } from "../src/version";
import { tempDir } from "./helpers";

describe("arguments", () => {
  it("reads the command, its words and the shared options", () => {
    expect(parse(["doctor", "--json", "-q", "--api-url", "http://localhost:8787", "--timeout", "5"])).toEqual({
      command: "doctor", rest: [], help: false, version: false, json: true, quiet: true, apiUrl: "http://localhost:8787", timeoutMs: 5000,
      format: undefined, output: undefined, stdout: false, force: false,
    });
    expect(parse(["scrape", "example.com", "-f", "links", "-o", "out/", "--force"])).toMatchObject({
      command: "scrape", rest: ["example.com"], format: "links", output: "out/", force: true, stdout: false,
    });
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

  it("only accept http(s) service addresses without credentials, query or fragment", () => {
    expect(checkApiUrl("https://crawler-free.crawler-free.workers.dev/")).toBe(DEFAULT_API);
    expect(checkApiUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(checkApiUrl("https://example.com/api//")).toBe("https://example.com/api");
    for (const bad of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com", "https://example.com/?k=1", "https://example.com/#x", "example.com", ""]) {
      expect(() => checkApiUrl(bad), bad).toThrow(CliError);
    }
  });

  const sys = async (): Promise<System> => {
    const dir = await tempDir();
    return { platform: process.platform, env: { APPDATA: join(dir, "AppData"), XDG_CONFIG_HOME: join(dir, ".config") }, homedir: dir };
  };

  it("are written, read back and reset; only the address and mode are kept", async () => {
    const s = await sys();
    expect(await readConfig(s)).toBeNull();
    const path = await writeConfig(s, { apiUrl: "https://my.example/", mode: "self-hosted" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ apiUrl: "https://my.example", mode: "self-hosted" });
    expect(await readConfig(s)).toEqual({ apiUrl: "https://my.example", mode: "self-hosted" });
    await resetConfig(s);
    expect(await readConfig(s)).toBeNull();
    await resetConfig(s); // resetting twice is fine
  });

  it("report a broken settings file with its path and how to fix it (exit 2)", async () => {
    const s = await sys();
    const path = await writeConfig(s, { apiUrl: DEFAULT_API, mode: "hosted" });
    const { writeFile } = await import("node:fs/promises");
    for (const text of ["{not json", "[]", "{}", '{"apiUrl":"ftp://x"}', '{"apiUrl":"https://u:p@x.example"}']) {
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
