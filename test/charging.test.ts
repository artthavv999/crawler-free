import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "../schema.sql?raw";
import { ApiError, checkUrl, normUrl } from "../src/guard";
import type { Env } from "../src/index";
import { sharedKey, subnetKey } from "../src/limits";
import { scrape } from "../src/scrape";

// Audit finding B (docs/beginner-cli-plan.md, E1): a request is checked before anything is spent. Per-connection limits
// count every valid read, cached or not; the shared page-read budget counts only fresh reads (cache misses). Nothing
// here reaches the network: fresh reads are stopped in their onMiss step, before any fetch.
const BASE = "https://crawler-free.example";
const HOST = "crawler-free.example";
const db = () => (env as unknown as Env).DB;
const counter = (k: string) => db().prepare("SELECT n FROM counters WHERE k = ?").bind(k).first<number>("n");
const shared = () => counter(sharedKey("page-reads"));
const send = (path: string, body: string, ip: string) =>
  SELF.fetch(`${BASE}${path}`, { method: "POST", body, headers: { "content-type": "application/json", "cf-connecting-ip": ip } });

// Puts an answer in the 1-hour cache for this address and formats, the way scrape() stores one.
async function cacheAnswer(url: string, formats: Record<string, unknown>, doc: unknown) {
  const data = new TextEncoder().encode(JSON.stringify([normUrl(checkUrl(url, HOST)), formats]));
  const key = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db().prepare("INSERT OR REPLACE INTO cache (k, body, expires) VALUES (?, ?, ?)").bind(key, JSON.stringify(doc), Math.floor(Date.now() / 1000) + 3600).run();
}

beforeAll(async () => { await db().exec(schema); });

it("refuses malformed scrape requests and blocked addresses without spending anything", async () => {
  const ip = "198.51.100.1";
  const cases: [string, string][] = [
    ["{oops", "BAD_REQUEST"],
    [JSON.stringify({ url: 5 }), "BAD_REQUEST"],
    [JSON.stringify({ url: "https://example.com/", formats: "markdown" }), "BAD_REQUEST"],
    [JSON.stringify({ url: "http://127.0.0.1/admin" }), "URL_BLOCKED"],
    [JSON.stringify({ url: "ftp://example.com/" }), "URL_BLOCKED"],
    [JSON.stringify({ url: "https://user:pw@example.com/" }), "URL_BLOCKED"],
  ];
  for (const [body, code] of cases) {
    const res = await send("/v2/scrape", body, ip);
    expect(res.status, body).toBe(400);
    expect(await res.json(), body).toMatchObject({ success: false, code });
  }
  expect(await counter(`scrape:${ip}`)).toBeNull();
  expect(await counter(`scrape-day:${ip}`)).toBeNull();
  expect(await shared()).toBeNull();
});

it("counts a cached answer against the caller, but not against the shared budget", async () => {
  const ip = "198.51.100.2";
  await cacheAnswer("https://example.com/cached", { markdown: true }, { markdown: "# Cached", metadata: { title: "Cached" } });
  const res = await send("/v2/scrape", JSON.stringify({ url: "https://example.com/cached" }), ip);
  expect(res.status).toBe(200);
  expect(res.headers.get("x-cache")).toBe("HIT");
  expect(await res.json()).toMatchObject({ success: true, data: { markdown: "# Cached" } });
  expect(await counter(`scrape:${ip}`)).toBe(1);
  expect(await counter(`scrape-day:${ip}`)).toBe(1);
  expect(await shared()).toBeNull();
});

it("spends the shared budget only on a cache miss, once, before fetching anything", async () => {
  const calls: string[] = [];
  const stop = async () => { calls.push("miss"); throw new ApiError(599, "STOPPED_BEFORE_FETCH", "test"); };
  await expect(scrape(env as unknown as Env, "https://example.com/fresh", { markdown: true }, HOST, "c", stop)).rejects.toMatchObject({ code: "STOPPED_BEFORE_FETCH" });
  expect(calls).toEqual(["miss"]);
  await cacheAnswer("https://example.com/warm", { markdown: true }, { markdown: "x", metadata: {} });
  const { hit } = await scrape(env as unknown as Env, "https://example.com/warm", { markdown: true }, HOST, "c", stop);
  expect(hit).toBe(true);
  expect(calls).toEqual(["miss"]); // not called for a cached answer
});

it("runs of saved setups: an unknown setup spends nothing; a cached run counts like a cached scrape", async () => {
  const ip = "198.51.100.3";
  const missing = await SELF.fetch(`${BASE}/run/zzzzzzzzzz`, { headers: { "cf-connecting-ip": ip } });
  expect(missing.status).toBe(404);
  await missing.body?.cancel();
  expect(await counter(`scrape:${ip}`)).toBeNull();

  const now = Math.floor(Date.now() / 1000);
  await db().prepare("INSERT INTO setups (id, url, mode, fields, created, last_run) VALUES (?, ?, ?, ?, ?, ?)").bind("savedsetup", "https://example.com/saved", "text", "[]", now, now).run();
  await cacheAnswer("https://example.com/saved", { markdown: true }, { markdown: "Saved page", metadata: {} });
  const run = await SELF.fetch(`${BASE}/run/savedsetup`, { headers: { "cf-connecting-ip": ip } });
  expect(run.status).toBe(200);
  expect(await run.text()).toBe("Saved page");
  expect(await counter(`scrape:${ip}`)).toBe(1);
  expect(await shared()).toBeNull();
});

it("refuses malformed crawl requests and blocked addresses without spending a crawl", async () => {
  const ip = "198.51.100.4";
  const cases: [string, string][] = [
    ["{oops", "BAD_REQUEST"],
    [JSON.stringify({ url: "https://example.com/", limit: 0 }), "BAD_REQUEST"],
    [JSON.stringify({ url: "https://example.com/", maxDiscoveryDepth: -1 }), "BAD_REQUEST"],
    [JSON.stringify({ url: "http://10.0.0.1/" }), "URL_BLOCKED"],
  ];
  for (const [body, code] of cases) {
    const res = await send("/v2/crawl", body, ip);
    expect(res.status, body).toBe(400);
    expect(await res.json(), body).toMatchObject({ success: false, code });
  }
  expect(await counter(`crawl:${ip}`)).toBeNull();
  expect(await counter(`crawl-net:${subnetKey(ip)}`)).toBeNull();
});
