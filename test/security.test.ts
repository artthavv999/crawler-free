import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "../schema.sql?raw";
import type { Env } from "../src/index";
import { discover, type Job } from "../src/crawl";
import { ApiError, checkUrl, isPublicIp, readCapped } from "../src/guard";
import { extractJson } from "../src/json";

// Regression tests for the HTTP-level defences in src/index.ts. They go through the real Worker (SELF) and never
// reach the network: every request here is refused, or handled with D1 alone.
const BASE = "https://crawler-free.example";
const db = () => (env as unknown as Env).DB;
const setup = JSON.stringify({ url: "https://example.com/", mode: "text" });
const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}${path}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

beforeAll(async () => { await db().exec(schema); });

it("refuses POST and DELETE from other websites' pages, before counting them against anyone", async () => {
  const browserHeaders: Record<string, string>[] = [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example" }, { origin: "null" }];
  for (const headers of browserHeaders) {
    // text/plain is what a hidden cross-site "simple" request would use: it skips CORS preflight
    const res = await post("/v2/setups", setup, { "content-type": "text/plain;charset=UTF-8", ...headers });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ success: false, code: "CROSS_SITE_BLOCKED" });
  }
  for (const path of ["/v2/scrape", "/v2/crawl"]) {
    const res = await post(path, JSON.stringify({ url: "https://example.com/" }), { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  }
  const del = await SELF.fetch(`${BASE}/v2/setups/abcdefghij`, { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } });
  expect(del.status).toBe(403);
  await del.body?.cancel();
  expect(await db().prepare("SELECT COUNT(*) AS n FROM counters").first("n")).toBe(0);
});

it("still accepts the web page itself and non-browser clients (SDKs, curl, PowerShell)", async () => {
  for (const headers of [{ "sec-fetch-site": "same-origin", origin: BASE }, { "sec-fetch-site": "none" }, {}] as Record<string, string>[]) {
    const res = await post("/v2/setups", setup, headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, mode: "text" });
  }
});

it("keeps run links working when they are opened from another site (GET is not blocked)", async () => {
  const res = await SELF.fetch(`${BASE}/run/abcdefghij`, { headers: { "sec-fetch-site": "cross-site" } });
  expect(res.status).toBe(404); // unknown setup, not 403: links shared in chats and issues must keep working
  await res.body?.cancel();
});

it("refuses request bodies over 64 KB that declare their size, before reading them", async () => {
  const big = JSON.stringify({ url: "https://example.com/", mode: "text", pad: "x".repeat(70 * 1024) });
  const res = await post("/v2/scrape", big, { "content-length": String(big.length) });
  expect(res.status).toBe(413);
  expect(await res.json()).toMatchObject({ success: false, code: "PAYLOAD_TOO_LARGE" });
  expect((await post("/v2/setups", setup)).status).toBe(200); // a normal body right after still works
});

it("caps bodies that don't declare a size while reading them", async () => {
  const chunks = (n: number) => new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(10_000).fill(120)); c.close(); },
  });
  const tooBig = () => new ApiError(413, "PAYLOAD_TOO_LARGE", "too big");
  await expect(readCapped(chunks(7), 64 * 1024, tooBig)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  expect((await readCapped(chunks(6), 64 * 1024, tooBig)).length).toBe(60_000);
  expect(await readCapped(null, 64 * 1024, tooBig)).toBe("");
});

it("sends security headers on every API response", async () => {
  const responses = [
    await SELF.fetch(`${BASE}/v2/nothing`),
    await post("/v2/scrape", "not json"),
    await SELF.fetch(`${BASE}/run/abcdefghij`),
    await post("/v2/setups", setup, { "sec-fetch-site": "cross-site" }),
  ];
  for (const res of responses) {
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await res.body?.cancel();
  }
});

it("does not pass the AI service's own error text to callers", async () => {
  const e = { AI: { run: async () => { throw new Error("upstream detail: account 0123abcd token misconfigured"); } } } as unknown as Env;
  const schema = { type: "object", properties: { title: { type: "string" } } };
  await expect(extractJson(e, "page text", { schema })).rejects.toMatchObject({
    code: "EXTRACT_FAILED",
    message: expect.not.stringContaining("0123abcd"),
  });
});

it("treats IANA special-purpose IPv6 blocks, malformed addresses and odd IPv4 spellings as non-public", () => {
  const notPublic = ["3fff::1", "3fff:fff:ffff::1", "2001:2::1", "2001:10::1", "2001:20::1", "2001:1ff:ffff::1", "2001:db8:ffff::1",
    "2002:a00:1::1", "::", "::ffff:7f00:1", "::ffff:10.0.0.1", "fc00::1", "ff02::1", "1:2:3:4:5:6:7:8:9", "2001:db8::1::2", "gggg::1"];
  for (const ip of notPublic) expect(isPublicIp(ip), ip).toBe(false);
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2001:200::1", "2620:4f:8000::1"]) expect(isPublicIp(ip), ip).toBe(true);
  const urls = ["http://0177.0.0.1/", "http://0/", "http://127.0.0.1./", "http://[0:0:0:0:0:ffff:7f00:1]/", "http://ⓛocalhost/",
    "http://LOCALHOST./", "http://[fe80::1%25eth0]/", "http://metadata/", "http://169.254.169.254:80/"];
  for (const u of urls) expect(() => checkUrl(u), u).toThrow(ApiError);
});

it("keeps crawls inside their starting folder on the same origin", async () => {
  await db().prepare("INSERT OR REPLACE INTO robots (origin, body, expires) VALUES (?, ?, ?)").bind("https://s.example", "", 9e9).run();
  const job: Job = { id: "scope", scope: "https://s.example/docs/", lim: 100, depth: 2, formats: "{}", self: "", created: 0 };
  const links = ["https://s.example/docs/a", "https://S.EXAMPLE:443/docs/b?x=1#frag", "https://s.example/docsearch/x",
    "https://s.example/docs/../admin", "https://s.example/docs/%2e%2e/admin", "https://s.example/", "http://s.example/docs/c",
    "https://s.example.evil.example/docs/d", "https://evil.example/docs/e", "https://user@s.example/docs/f", "https://s.example/docs/report.pdf"];
  expect(await discover(env as unknown as Env, job, links)).toEqual(["https://s.example/docs/a", "https://s.example/docs/b?x=1"]);
});
