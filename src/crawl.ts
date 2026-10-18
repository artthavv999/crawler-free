import { ApiError, checkUrl, normUrl, safeFetch, UA } from "./guard";
import { assertAllowed, robotsFor } from "./robots";
import { fitsRow, scrape, type Formats } from "./scrape";
import type { Env } from "./index";

export type CrawlMsg = { job: string; url: string; depth: number };
export type Job = { id: string; scope: string; lim: number; depth: number; formats: string; self: string; created: number };

const DAY = 86400;
const PAGE_SIZE = 10;
const MAX_MARKDOWN = 200_000; // chars per stored page; fitsRow() is the hard 2 MB guard

// One statement (D1 allows 50 queries and 100 bound params per invocation): keeps only URLs this job hasn't seen,
// up to the job's page limit. Depth is discovery hops from the seed, as in Firecrawl.
export async function claim(env: Env, job: Job, urls: string[], depth: number): Promise<string[]> {
  if (!urls.length) return [];
  const { results } = await env.DB.prepare(
    `INSERT OR IGNORE INTO pages (job, url, depth) SELECT ?1, value, ?2 FROM json_each(?3)
     WHERE value NOT IN (SELECT url FROM pages WHERE job = ?1)
     LIMIT max(0, ?4 - (SELECT COUNT(*) FROM pages WHERE job = ?1)) RETURNING url`,
  ).bind(job.id, depth, JSON.stringify([...new Set(urls)]), job.lim).all<{ url: string }>();
  return results.map((r) => r.url);
}

// Honours robots Crawl-delay (default 1 s, max 10 s) across concurrent consumers: slots for this host are reserved
// atomically on its robots row, and each message is delayed to its own slot.
async function enqueue(env: Env, job: Job, urls: string[], depth: number): Promise<void> {
  if (!urls.length) return;
  const first = new URL(urls[0]), now = Math.floor(Date.now() / 1000);
  const delay = Math.min(Math.max((await robotsFor(env.DB, first, job.self)).getCrawlDelay(UA) ?? 1, 1), 10);
  const start = (await env.DB.prepare("UPDATE robots SET next_slot = max(next_slot, ?1) + ?2 WHERE origin = ?3 RETURNING next_slot - ?2 AS start")
    .bind(now, urls.length * delay, first.origin).first<number>("start")) ?? now;
  await env.QUEUE.sendBatch(urls.map((url, i) => ({ body: { job: job.id, url, depth }, delaySeconds: Math.min(start - now + i * delay, 43200) })));
}

// shortcut: only the first sitemap (robots `Sitemap:` or /sitemap.xml), no sitemap-index recursion; recurse when
// crawls of sitemap-index sites come back short.
async function sitemap(env: Env, seed: URL, self: string): Promise<string[]> {
  const loc = (await robotsFor(env.DB, seed, self)).getSitemaps()[0] ?? `${seed.origin}/sitemap.xml`;
  try {
    const { res, body } = await safeFetch(loc, self, (u) => assertAllowed(env.DB, u, self));
    if (!res.ok) return [];
    return [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].flatMap(([, u]) => { try { return [normUrl(u.replace(/&amp;/g, "&"))]; } catch { return []; } });
  } catch {
    return [];
  }
}

const ASSET = /\.(xml|gz|zip|pdf|jpe?g|png|gif|webp|svg|ico|css|js|json|mp[34]|webm|woff2?|ttf|exe|dmg)$/i;

// Links worth a page slot: in scope, not a file asset, and allowed by robots.txt. Filtering before claim() keeps
// disallowed or non-HTML URLs from using up the job's page limit.
export async function discover(env: Env, job: Job, links: string[]): Promise<string[]> {
  const robot = await robotsFor(env.DB, new URL(job.scope), job.self);
  return links.flatMap((l) => {
    try { const u = new URL(normUrl(l)); return u.href.startsWith(job.scope) && !ASSET.test(u.pathname) && robot.isAllowed(u.href, UA) ? [u.href] : []; } catch { return []; }
  });
}

export async function startCrawl(env: Env, rawUrl: string, lim: number, depth: number, f: Formats, self: string, origin: string) {
  const seed = checkUrl(rawUrl, self);
  await assertAllowed(env.DB, seed, self);
  const job: Job = { id: crypto.randomUUID(), scope: seed.origin + seed.pathname.replace(/[^/]*$/, ""), lim, depth,
    formats: JSON.stringify(f), self, created: Math.floor(Date.now() / 1000) };
  await env.DB.prepare("INSERT INTO jobs (id, scope, lim, depth, formats, self, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(job.id, job.scope, lim, depth, job.formats, self, job.created).run();
  await enqueue(env, job, await claim(env, job, [normUrl(seed), ...(await discover(env, job, await sitemap(env, seed, self)))], 0), 0);
  return { success: true, id: job.id, url: `${origin}/v2/crawl/${job.id}` };
}

// Queue consumer: one URL per message. Never throws for a page error, so every page ends `done` or `failed`
// and the job's status converges.
// shortcut: a message the platform drops after retries leaves its page `queued` until the job expires (24 h);
// add a dead-letter queue if stuck jobs show up.
export async function crawlPage(env: Env, msg: CrawlMsg): Promise<void> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(msg.job).first<Job>();
  if (!job) return; // expired and cleaned up
  const f: Formats = JSON.parse(job.formats);
  let status = "done", data: unknown, found: string[] = [];
  try {
    const { doc } = await scrape(env, msg.url, { ...f, links: true }, job.self);
    found = await discover(env, job, doc.links ?? []);
    data = { ...doc, links: f.links ? doc.links : undefined, markdown: doc.markdown?.slice(0, MAX_MARKDOWN) };
  } catch (e) {
    status = "failed";
    data = e instanceof ApiError ? { code: e.code, error: e.message } : { code: "UNKNOWN_ERROR", error: "internal error" };
  }
  let row = JSON.stringify(data);
  if (!fitsRow(row)) { // an oversized row would make this UPDATE throw forever and leave the job stuck at "scraping"
    status = "failed";
    row = JSON.stringify({ code: "SCRAPE_FAILED", error: "page result too large to store" });
  }
  await env.DB.prepare("UPDATE pages SET status = ?, data = ? WHERE job = ? AND url = ?").bind(status, row, job.id, msg.url).run();
  if (msg.depth < job.depth) await enqueue(env, job, await claim(env, job, found, msg.depth + 1), msg.depth + 1);
}

export async function crawlStatus(env: Env, id: string, skip: number, origin: string) {
  const job = await env.DB.prepare("SELECT created FROM jobs WHERE id = ?").bind(id).first<{ created: number }>();
  if (!job) throw new ApiError(404, "NOT_FOUND", "crawl job not found (jobs expire after 24 h)");
  const c = await env.DB.prepare("SELECT SUM(status = 'done') AS done, SUM(status != 'failed') AS total, SUM(status = 'queued') AS queued FROM pages WHERE job = ?")
    .bind(id).first<{ done: number | null; total: number | null; queued: number | null }>();
  const { results } = await env.DB.prepare("SELECT data FROM pages WHERE job = ? AND status = 'done' ORDER BY rowid LIMIT ? OFFSET ?")
    .bind(id, PAGE_SIZE + 1, skip).all<{ data: string }>();
  return {
    success: true,
    status: c?.queued ? "scraping" : "completed",
    completed: c?.done ?? 0,
    total: c?.total ?? 0,
    creditsUsed: 0,
    expiresAt: new Date((job.created + DAY) * 1000).toISOString(),
    next: results.length > PAGE_SIZE ? `${origin}/v2/crawl/${id}?skip=${skip + PAGE_SIZE}` : null,
    data: results.slice(0, PAGE_SIZE).map((r) => JSON.parse(r.data)),
  };
}
