import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/errors";
import { VERSION } from "../src/version";
import { healthyApi, mockApi, run, sendJson, type Hit } from "./helpers";

let closeApi: (() => Promise<void>) | undefined;
afterEach(async () => { await closeApi?.(); closeApi = undefined; });
const api = async (handler: Parameters<typeof mockApi>[0] = healthyApi) => { const m = await mockApi(handler); closeApi = m.close; return m; };

describe("crawler-free (no command, help, version)", () => {
  it("prints the version", async () => {
    expect(await run(["--version"])).toMatchObject({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
    expect(JSON.parse((await run(["-v", "--json"])).stdout)).toEqual({ ok: true, version: VERSION });
  });

  it("prints help on --help (exit 0) and on no command (stderr, exit 2)", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage\n  crawler-free <command> [options]");
    expect(help.stdout).toContain("doctor");
    const none = await run([]);
    expect(none).toMatchObject({ code: EXIT.usage, stdout: "" });
    expect(none.stderr).toContain("Usage");
  });

  it("explains unknown commands, commands from later phases and bad options (exit 2)", async () => {
    const unknown = await run(["scrapee"]);
    expect(unknown).toMatchObject({ code: EXIT.usage, stdout: "" });
    expect(unknown.stderr).toBe('Error: Unknown command "scrapee".\nRun `crawler-free --help` to see the commands.\n');
    for (const later of ["extract", "setup"]) {
      const r = await run([later, "https://example.com"]);
      expect(r.code).toBe(EXIT.usage);
      expect(r.stderr).toContain(`"${later}" isn't available in this preview yet.`);
    }
    const wrongCommand = await run(["doctor", "--format", "links"]);
    expect(wrongCommand.code).toBe(EXIT.usage);
    expect(wrongCommand.stderr).toContain('--format doesn\'t work with "doctor".');
    const bad = await run(["doctor", "--nope", "--json"]);
    expect(bad.code).toBe(EXIT.usage);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: { code: "USAGE", exitCode: EXIT.usage, message: "Unknown option '--nope'." } });
  });

  it("hides stack traces unless CRAWLER_FREE_DEBUG is set", async () => {
    const boom = () => { throw new Error("stdout closed"); };
    const quiet = await run(["--help"], { stdout: boom });
    expect(quiet.code).toBe(EXIT.failed);
    expect(quiet.stderr).toContain("Something went wrong inside crawler-free.");
    expect(quiet.stderr).not.toMatch(/\n\s+at /);
    const debug = await run(["--help"], { stdout: boom, env: { CRAWLER_FREE_DEBUG: "1" } });
    expect(debug.stderr).toMatch(/Error: stdout closed\n\s+at /);
  });
});

describe("crawler-free doctor", () => {
  it("passes every check against a healthy service", async () => {
    const m = await api();
    const r = await run(["doctor", "--api-url", m.url]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`Crawler Free doctor (CLI ${VERSION})`);
    expect(r.stdout.match(/^ {2}ok {4}/gm)).toHaveLength(5);
    expect(r.stdout).toContain("All checks passed.");
    expect(m.hits.map((h: Hit) => `${h.method} ${h.url}`)).toEqual(["GET /", "GET /v2/crawl/00000000-0000-4000-8000-000000000000"]);
  });

  it("prints machine-readable results with --json", async () => {
    const m = await api();
    const r = await run(["doctor", "--json", "--api-url", m.url]);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ ok: true, version: VERSION, apiUrl: m.url, apiUrlSource: "--api-url" });
    expect(out.checks.map((c: { name: string }) => c.name)).toEqual(["node", "settings", "connection", "api", "output"]);
  });

  it("still passes while status checks are rate limited", async () => {
    const m = await api((hit, res) => hit.url === "/" ? healthyApi(hit, res) : sendJson(res, 429, { success: false, code: "RATE_LIMITED", error: "wait" }, { "retry-after": "30" }));
    expect((await run(["doctor", "--api-url", m.url])).code).toBe(0);
  });

  it("fails clearly when the address isn't a Crawler Free service (exit 1)", async () => {
    const m = await api((_hit, res) => { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>Not here</h1>"); });
    const r = await run(["doctor", "--api-url", m.url]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.stdout).toContain("FAIL  This address doesn't answer like a Crawler Free service.");
  });

  it("fails with exit 5 when the service can't be reached, and skips the API check", async () => {
    const m = await api();
    const url = m.url;
    await m.close(); closeApi = undefined;
    const r = await run(["doctor", "--json", "--api-url", url, "--timeout", "2"]);
    expect(r.code).toBe(EXIT.network);
    const out = JSON.parse(r.stdout);
    expect(out.checks.map((c: { name: string; ok: boolean }) => `${c.name}:${c.ok}`)).toEqual(["node:true", "settings:true", "connection:false", "output:true"]);
  });

  it("reports an old Node.js (exit 1), a broken settings file (exit 2) and an unwritable folder (exit 6)", async () => {
    const m = await api();
    expect((await run(["doctor", "--api-url", m.url], { nodeVersion: "20.18.0" })).code).toBe(EXIT.failed);

    const home = (await run(["--version"])).home;
    const env = { APPDATA: join(home, "AppData"), XDG_CONFIG_HOME: join(home, ".config") };
    const dir = process.platform === "win32" ? join(env.APPDATA, "crawler-free") : join(env.XDG_CONFIG_HOME, "crawler-free");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), "{oops");
    const broken = await run(["doctor", "--api-url", m.url], { env, homedir: home, cwd: home });
    expect(broken.code).toBe(EXIT.usage);
    expect(broken.stdout).toContain("isn't valid JSON");
    expect(broken.stdout).toContain(`Delete it to go back to the hosted service: ${join(dir, "config.json")}`);
    expect(broken.stdout).toContain(`ok    Reached ${m.url}`); // --api-url still lets the connection be checked

    const gone = await run(["doctor", "--api-url", m.url], { cwd: join(home, "no-such-folder") });
    expect(gone.code).toBe(EXIT.output);
    expect(gone.stdout).toContain("isn't writable, so results can't be saved here.");
  });
});
