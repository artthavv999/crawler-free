import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "../schema.sql?raw";
import { claim, type Job } from "../src/crawl";
import { ApiError } from "../src/guard";
import type { Env } from "../src/index";
import { addShared, rateLimit, SHARED, sharedKey, sharedLeft, spendShared, subnetKey } from "../src/limits";
import { scrape } from "../src/scrape";

// Regression tests for the F2 limits (docs/security-audit.md): per-connection daily page reads, network limits,
// shared daily budgets, and refusals that write nothing. Nothing here reaches the network. Used-up shared budgets
// are remembered for the rest of the isolate, so each test uses its own budget name or runs in a known order.
const BASE = "https://crawler-free.example";
const db = () => (env as unknown as Env).DB;
const counter = (k: string) => db().prepare("SELECT n FROM counters WHERE k = ?").bind(k).first<number>("n");
const setCounter = (k: string, n: number) =>
  db().prepare("INSERT OR REPLACE INTO counters (k, n, reset) VALUES (?, ?, ?)").bind(k, n, Math.floor(Date.now() / 1000) + 3600).run();
// Each test calls from its own address (Cloudflare sets cf-connecting-ip in production; here the test does), because
// refusals are remembered per address for the rest of the window.
const post = (path: string, body: unknown, ip: string) =>
  SELF.fetch(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "cf-connecting-ip": ip } });

beforeAll(async () => { await db().exec(schema); });

it("groups connections into their IPv4 /24 or IPv6 /48 network", () => {
  expect(subnetKey("203.0.113.77")).toBe("203.0.113.0/24");
  expect(subnetKey("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
  expect(subnetKey("2001:db8:aa:1::1")).toBe("2001:db8:aa::/48");
  expect(subnetKey("2001:DB8:AA:ffff:1:2:3:4")).toBe(subnetKey("2001:db8:aa::9"));
  expect(subnetKey("2001:db8:aa:1::/64")).toBe("2001:db8:aa::/48"); // a clientKey() works too
  expect(subnetKey("2001:db8:ab::1")).not.toBe(subnetKey("2001:db8:aa::1"));
  expect(subnetKey("unknown")).toBe("unknown");
});

it("refused requests write nothing, and repeat refusals don't touch D1 at all", async () => {
  for (let i = 0; i < 3; i++) await rateLimit(db(), "t", "a", 3, 60);
  for (let i = 0; i < 5; i++) await expect(rateLimit(db(), "t", "a", 3, 60)).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
  expect(await counter("t:a")).toBe(3); // stayed at the limit: the refused upserts changed nothing
  const noD1 = { prepare: () => { throw new Error("D1 was used"); } } as unknown as D1Database;
  await expect(rateLimit(noD1, "t", "a", 3, 60)).rejects.toMatchObject({ code: "RATE_LIMITED" });
});

it("a shared daily budget refuses with 503 once used up, resets at 00:00 UTC, and stops writing", async () => {
  for (let i = 0; i < 4; i++) await spendShared(db(), "budget-test", 4);
  const err = await spendShared(db(), "budget-test", 4).catch((e: ApiError) => e);
  expect(err).toMatchObject({ status: 503, code: "DAILY_BUDGET_EXHAUSTED" });
  expect((err as ApiError).message).toMatch(/^Today's shared allowance of 4 budget-test for everyone is used up\. It resets at 00:00 UTC, in /);
  const wait = +(err as ApiError).headers["retry-after"];
  expect(wait).toBeGreaterThan(0);
  expect(wait).toBeLessThanOrEqual(86400);
  expect((Math.floor(Date.now() / 1000) + wait) % 86400).toBeLessThan(5); // lands on midnight UTC
  expect(await counter(sharedKey("budget-test"))).toBe(4);
});

it("caps page reads at 1,000 a day per connection", async () => {
  await setCounter("scrape-day:192.0.2.10", 1000);
  const res = await post("/v2/scrape", { url: "https://example.com/" }, "192.0.2.10");
  expect(res.status).toBe(429);
  expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", error: expect.stringMatching(/^You've used all 1,000 page reads allowed per 24 hours\./) });
});

it("caps whole-website reads at 10 a day per network", async () => {
  await setCounter("crawl-net:198.18.7.0/24", 10);
  const res = await post("/v2/crawl", { url: "https://example.com/" }, "198.18.7.40");
  expect(res.status).toBe(429);
  expect(await res.json()).toMatchObject({ error: expect.stringMatching(/^Connections on your network have used all 10 whole-website reads allowed per 24 hours\./) });
});

it("caps fact look-ups at 60 a day per network", async () => {
  await setCounter("json-net:198.51.100.0/24", 60);
  const facts = { json: { schema: { type: "object", properties: { title: { type: "string" } } } } };
  await expect(scrape(env as unknown as Env, "https://example.com/", facts, "self.example", "198.51.100.7"))
    .rejects.toMatchObject({ code: "RATE_LIMITED", message: expect.stringMatching(/^Connections on your network have used all 60 fact look-ups/) });
  expect(await counter("json:198.51.100.7")).toBe(1); // the connection's own count went up; the network's stayed at 60
  expect(await counter("json-net:198.51.100.0/24")).toBe(60);
});

it("charges crawled pages to the shared budget as they are queued, and stops at it", async () => {
  await setCounter(sharedKey("crawl-pages"), SHARED.crawlPages - 2);
  const job: Job = { id: "budget-job", scope: "https://a.example/", lim: 50, depth: 2, formats: "{}", self: "", created: 0 };
  const urls = ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"];
  expect(await claim(env as unknown as Env, job, urls, 0)).toHaveLength(2);
  expect(await counter(sharedKey("crawl-pages"))).toBe(SHARED.crawlPages);
  expect(await claim(env as unknown as Env, job, ["https://a.example/5"], 1)).toHaveLength(0);
  await expect(sharedLeft(db(), "crawl-pages", SHARED.crawlPages)).rejects.toMatchObject({ status: 503, code: "DAILY_BUDGET_EXHAUSTED" });
});

it("refuses new crawls once the shared crawl budget is used up, without spending the caller's allowance", async () => {
  const before = await counter("crawl:192.0.2.30");
  const res = await post("/v2/crawl", { url: "https://example.com/" }, "192.0.2.30");
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  expect(await res.json()).toMatchObject({ code: "DAILY_BUDGET_EXHAUSTED", error: expect.stringMatching(/^Today's shared allowance of 2,500 whole-website pages/) });
  expect(await counter("crawl:192.0.2.30")).toBe(before);
});

it("refuses page reads once the shared page-read budget is used up", async () => {
  await addShared(db(), "page-reads", SHARED.pageReads);
  const first = await post("/v2/scrape", { url: "https://example.com/" }, "192.0.2.20");
  expect(first.status).toBe(503);
  expect(await first.json()).toMatchObject({ code: "DAILY_BUDGET_EXHAUSTED", error: expect.stringMatching(/^Today's shared allowance of 15,000 page reads/) });
  const spent = await counter("scrape-day:192.0.2.20");
  const again = await post("/v2/scrape", { url: "https://example.com/" }, "192.0.2.20");
  expect(again.status).toBe(503);
  await again.body?.cancel();
  expect(await counter("scrape-day:192.0.2.20")).toBe(spent); // known used up: refused before the caller's own limits
});
