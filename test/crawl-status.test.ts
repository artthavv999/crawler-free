import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "../schema.sql?raw";
import { crawlStatus } from "../src/crawl";
import type { Env } from "../src/index";

// Crawl status reports failed pages (docs/cli-plan.md, D5): a `failed` count always, and `failures` once finished.
const db = () => (env as unknown as Env).DB;
const ORIGIN = "https://crawler-free.example";
const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function page(url: string, status: string, data: unknown) {
  await db().prepare("INSERT INTO pages (job, url, depth, status, data) VALUES (?, ?, 1, ?, ?)").bind(ID, url, status, data === null ? null : JSON.stringify(data)).run();
}

beforeAll(async () => {
  await db().exec(schema);
  await db().prepare("INSERT INTO jobs (id, scope, lim, depth, formats, self, created) VALUES (?, 'https://s.example/', 30, 2, '{}', '', ?)").bind(ID, Math.floor(Date.now() / 1000)).run();
  for (let i = 0; i < 12; i++) await page(`https://s.example/p${i}`, "done", { markdown: `page ${i}`, metadata: { sourceURL: `https://s.example/p${i}` } });
  await page("https://s.example/robots-no", "failed", { code: "ROBOTS_DISALLOWED", error: "robots.txt disallows https://s.example/robots-no for CrawlerFree" });
  await page("https://s.example/huge", "failed", { code: "SCRAPE_FAILED", error: "page larger than 5 MB" });
  await page("https://s.example/later", "queued", null);
});

it("counts failed pages while the crawl runs, without listing them yet", async () => {
  const s = await crawlStatus(env as unknown as Env, ID, 0, ORIGIN);
  expect(s).toMatchObject({ success: true, status: "scraping", completed: 12, total: 13, failed: 2 });
  expect(s).not.toHaveProperty("failures");
  expect(s.data).toHaveLength(10);
  expect(s.next).toBe(`${ORIGIN}/v2/crawl/${ID}?skip=10`);
});

it("lists each failed page with its code once finished, on the first results page only", async () => {
  await db().prepare("UPDATE pages SET status = 'done', data = ? WHERE job = ? AND url = ?").bind(JSON.stringify({ markdown: "late", metadata: {} }), ID, "https://s.example/later").run();
  const first = await crawlStatus(env as unknown as Env, ID, 0, ORIGIN);
  expect(first).toMatchObject({ status: "completed", completed: 13, total: 13, failed: 2 });
  expect(first.failures).toEqual([
    { url: "https://s.example/robots-no", code: "ROBOTS_DISALLOWED", error: "robots.txt disallows https://s.example/robots-no for CrawlerFree" },
    { url: "https://s.example/huge", code: "SCRAPE_FAILED", error: "page larger than 5 MB" },
  ]);
  const second = await crawlStatus(env as unknown as Env, ID, 10, ORIGIN);
  expect(second).not.toHaveProperty("failures");
  expect(second).toMatchObject({ failed: 2, next: null });
  expect(second.data).toHaveLength(3);
});

it("keeps the existing fields and adds the new ones over HTTP", async () => {
  const res = await SELF.fetch(`${ORIGIN}/v2/crawl/${ID}`, { headers: { "cf-connecting-ip": "192.0.2.77" } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["success", "status", "completed", "total", "failed", "creditsUsed", "expiresAt", "next", "data", "failures"]);
  expect(body).toMatchObject({ status: "completed", failed: 2 });
});

it("reports zero failures as failed: 0 with no failures list", async () => {
  const other = "11111111-2222-4333-8444-555555555555";
  await db().prepare("INSERT INTO jobs (id, scope, lim, depth, formats, self, created) VALUES (?, 'https://t.example/', 5, 1, '{}', '', ?)").bind(other, Math.floor(Date.now() / 1000)).run();
  await db().prepare("INSERT INTO pages (job, url, depth, status, data) VALUES (?, 'https://t.example/', 0, 'done', ?)").bind(other, JSON.stringify({ markdown: "x", metadata: {} })).run();
  const s = await crawlStatus(env as unknown as Env, other, 0, ORIGIN);
  expect(s).toMatchObject({ status: "completed", completed: 1, total: 1, failed: 0 });
  expect(s).not.toHaveProperty("failures");
});
