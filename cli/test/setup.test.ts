import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_API } from "../src/client";
import { configPath } from "../src/config";
import { EXIT } from "../src/errors";
import { HOSTED_LIMITS } from "../src/setup";
import { healthyApi, mockApi, run, tempDir, type Hit } from "./helpers";

let closeApi: (() => Promise<void>) | undefined;
afterEach(async () => { await closeApi?.(); closeApi = undefined; });
const api = async (handler: (hit: Hit, res: ServerResponse) => void = healthyApi) => { const m = await mockApi(handler); closeApi = m.close; return m; };

// A computer of its own for each test: settings live under a fresh temporary home.
async function computer() {
  const home = await tempDir();
  const env: Record<string, string | undefined> = { APPDATA: join(home, "AppData"), XDG_CONFIG_HOME: join(home, ".config") };
  const settings = configPath({ platform: process.platform, env, homedir: home });
  const on = (over: Parameters<typeof run>[1] = {}) => ({ env, homedir: home, cwd: home, ...over });
  const saved = () => readFile(settings, "utf8").then((t) => JSON.parse(t), () => null);
  return { home, env, settings, on, saved };
}
// Sends requests for the hosted service to the mock instead, so the hosted path is tested without the real service.
const viaMock = (m: { url: string }): typeof fetch => (input, init) => fetch(String(input).replace(DEFAULT_API, m.url), init);
const answers = (...list: string[]) => {
  const questions: string[] = [];
  return { questions, ask: async (q: string) => { questions.push(q); return list.shift() ?? ""; } };
};
const NO_SUCH_JOB = "GET /v2/crawl/00000000-0000-4000-8000-000000000000";

describe("crawler-free setup", () => {
  it("in a script with no options: picks the hosted service, checks it, and saves only that choice", async () => {
    const m = await api();
    const c = await computer();
    const r = await run(["setup"], c.on({ fetch: viaMock(m) }));
    expect(r.code).toBe(EXIT.ok);
    expect(await c.saved()).toEqual({ mode: "hosted" });
    expect(m.hits.map((h) => `${h.method} ${h.url}`)).toEqual(["GET /", NO_SUCH_JOB]);
    expect(r.stdout).toBe(`Saved. crawler-free will use the free hosted service (${DEFAULT_API}).\n`
      + `Settings file: ${c.settings}\n`
      + "To change it, run `crawler-free setup` again. To remove the file and go back to the hosted service, run `crawler-free setup --reset`.\n"
      + `\n${HOSTED_LIMITS}\nTry it: crawler-free scrape https://example.com\n`);
    expect(r.stderr).toContain("Using the free hosted service (the default). For your own copy instead: crawler-free setup --api-url <address>\n");
    expect(r.stderr).toMatch(new RegExp(`Checking ${DEFAULT_API} \\.\\.\\.\\n  ok    Reached ${DEFAULT_API} \\(HTTP 200, \\d+ ms\\)\\n  ok    The API answered`));
    expect(await readFile(c.settings, "utf8")).not.toMatch(/token|key|password/i);
  });

  it("--api-url saves your own service, which every command then uses; --reset goes back to hosted", async () => {
    const m = await api();
    const c = await computer();
    const r = await run(["setup", "--api-url", `${m.url}/`], c.on());
    expect(r.code).toBe(EXIT.ok);
    expect(await c.saved()).toEqual({ mode: "self-hosted", apiUrl: m.url });
    expect(r.stdout).toContain(`Saved. crawler-free will use your own service at ${m.url}.\n`);
    expect(r.stdout).toContain("Its limits are the ones set in your copy's code and Cloudflare account.\n");
    expect(r.stdout).not.toContain("20 page reads");

    const doctor = await run(["doctor"], c.on());
    expect(doctor.code).toBe(EXIT.ok);
    expect(doctor.stdout).toContain(`Reached ${m.url} (HTTP 200`);
    expect(doctor.stdout).toContain("address from settings file");

    const reset = await run(["setup", "--reset"], c.on());
    expect(reset).toMatchObject({ code: EXIT.ok, stdout: `Removed the settings file ${c.settings}. crawler-free uses the free hosted service.\n` });
    await expect(stat(dirname(c.settings))).rejects.toMatchObject({ code: "ENOENT" }); // its empty folder too
    const again = await run(["setup", "--reset"], c.on());
    expect(again.stdout).toBe(`There was no settings file (${c.settings}). crawler-free uses the free hosted service.\n`);
    expect(m.hits.filter((h) => h.url === "/")).toHaveLength(2); // the reset never contacts the service
  });

  it("asks at a terminal: Enter means the hosted service", async () => {
    const m = await api();
    const c = await computer();
    const a = answers("");
    const r = await run(["setup"], c.on({ fetch: viaMock(m), ask: a.ask }));
    expect(r.code).toBe(EXIT.ok);
    expect(await c.saved()).toEqual({ mode: "hosted" });
    expect(a.questions).toEqual(["Crawler Free setup\nRight now crawler-free uses the free hosted service (the default; nothing saved yet).\n\n"
      + "Which service should it use?\n"
      + "  1  The free hosted service (recommended): nothing to install, no account or key\n"
      + "  2  Your own copy on your Cloudflare account (self-hosted, for advanced users)\n"
      + "Type 1 or 2 [1]: "]);
  });

  it("asks at a terminal: your own copy, explaining what it needs and asking again after a bad address", async () => {
    const m = await api();
    const c = await computer();
    await mkdir(dirname(c.settings), { recursive: true });
    await writeFile(c.settings, JSON.stringify({ mode: "hosted" }));
    const a = answers("2", "ftp://nope.example", m.url);
    const r = await run(["setup"], c.on({ ask: a.ask }));
    expect(r.code).toBe(EXIT.ok);
    expect(await c.saved()).toEqual({ mode: "self-hosted", apiUrl: m.url });
    expect(a.questions[0]).toContain(`Right now crawler-free uses the free hosted service (${DEFAULT_API}).`);
    expect(a.questions[1]).toBe("\nThis needs your own copy of Crawler Free deployed first. The steps are in the README:\n"
      + "  https://github.com/artthavv999/crawler-free#self-hosting-cloudflare-free-0\n\n"
      + "Your service's address (for example https://crawler-free.<your-subdomain>.workers.dev): ");
    expect(a.questions[2]).toBe("The service address must start with https:// (got ftp:). Type the address again: ");
    expect(a.questions).toHaveLength(3);
  });

  it("gives up after three unclear answers, saving nothing and contacting no one", async () => {
    const m = await api();
    const c = await computer();
    const choice = await run(["setup"], c.on({ ask: answers("3", "hosted", "yes").ask, fetch: viaMock(m) }));
    expect(choice).toMatchObject({ code: EXIT.usage, stderr: "Error: No choice was made, so nothing was saved.\nRun `crawler-free setup` again, or use --hosted or --api-url <address>.\n" });
    const address = await run(["setup"], c.on({ ask: answers("2", "", "", "").ask }));
    expect(address.code).toBe(EXIT.usage);
    expect(address.stderr).toContain("No usable address was given, so nothing was saved.");
    expect(await c.saved()).toBeNull();
    expect(m.hits).toEqual([]);
  });

  it("saves nothing when the check fails, unless --force or a yes", async () => {
    const down = await api((hit, res) => { res.writeHead(500); res.end("oops"); });
    const c = await computer();
    const failed = await run(["setup", "--api-url", down.url], c.on());
    expect(failed.code).toBe(EXIT.failed);
    expect(failed.stderr).toContain(`  FAIL  ${down.url} answered HTTP 500.\n`);
    expect(failed.stderr).toContain(`Error: Nothing was saved: ${down.url} answered HTTP 500.\nThe service may be having trouble; try again in a few minutes. Check the address and try again, or add --force to save it anyway.\n`);
    expect(await c.saved()).toBeNull();
    const no = await run(["setup", "--api-url", down.url], c.on({ ask: answers("n").ask }));
    expect(no.code).toBe(EXIT.failed);
    expect(await c.saved()).toBeNull();

    const yes = answers("y");
    expect((await run(["setup", "--api-url", down.url], c.on({ ask: yes.ask }))).code).toBe(EXIT.ok);
    expect(yes.questions).toEqual(["The check failed. Save this setting anyway? [y/N] "]);
    await run(["setup", "--reset"], c.on());
    const forced = await run(["setup", "--api-url", down.url, "--force"], c.on());
    expect(forced.code).toBe(EXIT.ok);
    expect(forced.stdout).toContain("The connection check failed, so it may not work yet.\n");
    expect(await c.saved()).toEqual({ mode: "self-hosted", apiUrl: down.url });
  });

  it("refuses an address that isn't a Crawler Free service, or can't be reached (exit 5)", async () => {
    const other = await api((hit, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Some other site</title>"); });
    const c = await computer();
    const r = await run(["setup", "--api-url", other.url], c.on());
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toContain("Error: Nothing was saved: This address doesn't answer like a Crawler Free service.");
    await closeApi?.();
    closeApi = undefined;

    const port = await new Promise<number>((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });
    const gone = await run(["setup", "--api-url", `http://127.0.0.1:${port}`, "--timeout", "2"], c.on());
    expect(gone.code).toBe(EXIT.network);
    expect(gone.stderr).toContain("Error: Nothing was saved: Couldn't reach 127.0.0.1:");
    expect(await c.saved()).toBeNull();
  });

  it("prints JSON with --json (never asking) and only the settings file with --quiet", async () => {
    const m = await api();
    const c = await computer();
    const a = answers("2");
    const json = await run(["setup", "--api-url", m.url, "--json"], c.on({ ask: a.ask }));
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true, command: "setup", mode: "self-hosted", apiUrl: m.url, settingsFile: c.settings, checked: true,
      checks: [expect.objectContaining({ name: "connection", ok: true }), expect.objectContaining({ name: "api", ok: true })], overriddenBy: null,
    });
    const noFlags = await run(["setup", "--json"], c.on({ ask: a.ask, fetch: viaMock(m) }));
    expect(JSON.parse(noFlags.stdout)).toMatchObject({ ok: true, mode: "hosted" });
    expect(a.questions).toEqual([]);
    const quiet = await run(["setup", "--hosted", "-q"], c.on({ fetch: viaMock(m) }));
    expect(quiet).toMatchObject({ code: EXIT.ok, stdout: `${c.settings}\n`, stderr: "" });
    const reset = await run(["setup", "--reset", "--json"], c.on());
    expect(JSON.parse(reset.stdout)).toEqual({ ok: true, command: "setup", reset: true, removed: true, settingsFile: c.settings, overriddenBy: null });
  });

  it("mentions CRAWLER_FREE_API_URL when it overrides the saved choice, and replaces a broken settings file", async () => {
    const m = await api();
    const c = await computer();
    await mkdir(dirname(c.settings), { recursive: true });
    await writeFile(c.settings, "{oops");
    c.env.CRAWLER_FREE_API_URL = "https://env.example";
    const r = await run(["setup", "--hosted"], c.on({ fetch: viaMock(m) }));
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain(`The settings file ${c.settings} can't be used; this setup will replace it.\n`);
    expect(r.stdout).toContain("Note: CRAWLER_FREE_API_URL is set (https://env.example), so it's used instead of this setting until you remove it.\n");
    expect(await c.saved()).toEqual({ mode: "hosted" });
  });

  it("checks its options before doing anything (exit 2)", async () => {
    const m = await api();
    const c = await computer();
    const cases: [string[], string][] = [
      [["setup", "https://my.example"], 'setup doesn\'t take an address as a word (got "https://my.example").'],
      [["setup", "--hosted", "--api-url", m.url], "Choose one: --hosted or --api-url."],
      [["setup", "--reset", "--hosted"], "--reset can't be combined with other setup options."],
      [["setup", "--reset", "--force"], "--reset can't be combined with other setup options."],
      [["setup", "--api-url", "ftp://my.example"], "The service address must start with https:// (got ftp:)."],
      [["setup", "--fields", "title"], '--fields doesn\'t work with "setup".'],
      [["setup", "--output", "x"], '--output doesn\'t work with "setup".'],
      [["scrape", "https://example.com", "--hosted"], '--hosted doesn\'t work with "scrape".'],
      [["doctor", "--reset"], '--reset doesn\'t work with "doctor".'],
    ];
    for (const [argv, message] of cases) {
      const r = await run(argv, c.on());
      expect(r.code, argv.join(" ")).toBe(EXIT.usage);
      expect(r.stderr, argv.join(" ")).toContain(`Error: ${message}`);
    }
    expect(m.hits).toEqual([]);
    expect(await c.saved()).toBeNull();
  });
});
