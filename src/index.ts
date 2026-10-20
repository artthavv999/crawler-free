import { crawlPage, crawlStatus, startCrawl, type CrawlMsg } from "./crawl";
import { ApiError, checkUrl, readCapped } from "./guard";
import { assertShared, clientKey, rateLimit, SHARED, sharedLeft, spendShared, subnetKey } from "./limits";
import { scrape, type Formats } from "./scrape";
import { asText, createSetup, loadSetup, runSetup, SETUP_TTL } from "./setups";

export interface Env {
  DB: D1Database;
  QUEUE: Queue<CrawlMsg>;
  AI: Ai;
  DISABLED?: string;
  CF_ACCOUNT_ID?: string;
  CF_BROWSER_TOKEN?: string;
}

const SILENT = ["origin", "integration"]; // the Firecrawl SDK injects `origin` into every POST
const MAX_BODY = 64 * 1024; // the largest valid body (10,000-character schema + 2,000-character prompt) is far smaller

// Added to every Worker response (static files get theirs from public/_headers). API output is data, never a page:
// no MIME sniffing, no framing, and nothing loads or runs if a browser opens it (e.g. /run/{id} page text).
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store", // results and crawl status are never kept by browsers or proxies (the D1 cache is separate)
};

// Browsers label requests with where they came from; SDKs, curl and PowerShell send neither header. Cross-site
// "simple" requests (text/plain bodies) skip CORS preflight, so without this check any website could make its
// visitors' browsers start scrapes and crawls, spending their limits and the shared daily budgets.
function fromOtherSite(req: Request, origin: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const from = req.headers.get("origin");
  return from !== null && from !== origin;
}

// Every valid page read (scrape or saved-setup run), cached or not, counts against the caller: 20 a minute and 1,000 a
// day per connection. Callers check the request first, so a malformed or refused one spends nothing (audit finding B).
async function pageRead(db: D1Database, client: string): Promise<void> {
  await rateLimit(db, "scrape", client, 20, 60);
  await rateLimit(db, "scrape-day", client, 1000, 86400);
}
// The shared daily budget is spent only by a fresh read (a cache miss), just before the page is fetched: an answer from
// the cache does no outside work. Passed to scrape() as its onMiss step.
const freshRead = (db: D1Database) => () => spendShared(db, "page-reads", SHARED.pageReads);

const tooLarge = () => new ApiError(413, "PAYLOAD_TOO_LARGE", `request body is larger than ${MAX_BODY / 1024} KB`);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  // explicit charset: Windows PowerShell 5.1 decodes JSON without one as Latin-1 (“ became â€œ)
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

// json is refused inside crawls: one crawl could drain the shared 10k-neuron daily AI budget.
function parseFormats(raw: unknown, warn: string[], allowJson = true): Formats {
  if (raw === undefined) return { markdown: true };
  if (!Array.isArray(raw)) throw new ApiError(400, "BAD_REQUEST", "formats must be an array");
  const f: Formats = {};
  for (const x of raw) {
    const type = typeof x === "string" ? x : (x as { type?: unknown } | null)?.type;
    if (type === "markdown" || type === "links") f[type] = true;
    else if (type === "json" && allowJson) {
      const { schema, prompt } = x as { schema?: unknown; prompt?: unknown };
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new ApiError(400, "BAD_REQUEST", "json format needs a JSON Schema object in schema");
      if (JSON.stringify(schema).length > 10_000) throw new ApiError(400, "BAD_REQUEST", "json schema is larger than 10,000 characters"); // AI budget is shared
      f.json = { schema: schema as Record<string, unknown>, ...(typeof prompt === "string" && { prompt: prompt.slice(0, 2000) }) };
    }
    else warn.push(`format ${JSON.stringify(type)} is not supported`);
  }
  return f;
}

function clamp(raw: unknown, dflt: number, min: number, max: number, name: string, warn: string[]): number {
  const n = raw === undefined ? dflt : Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ApiError(400, "BAD_REQUEST", `${name} must be an integer >= ${min}`);
  if (n > max) warn.push(`${name} capped at ${max}`);
  return Math.min(n, max);
}

// Unknown fields are accepted, ignored and reported (Firecrawl itself rejects them).
async function readBody(req: Request, known: string[], warn: string[]): Promise<Record<string, unknown> & { url: string }> {
  const text = await readCapped(req.body, MAX_BODY, tooLarge); // also caps chunked bodies with no content-length
  const body = (() => { try { return JSON.parse(text) as unknown; } catch { return null; } })();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "BAD_REQUEST", "body must be a JSON object");
  const extra = Object.keys(body).filter((k) => !known.includes(k) && !SILENT.includes(k));
  if (extra.length) warn.push(`ignored unsupported fields: ${extra.join(", ")}`);
  if (typeof (body as { url?: unknown }).url !== "string") throw new ApiError(400, "BAD_REQUEST", "url is required");
  return body as Record<string, unknown> & { url: string };
}

async function handle(req: Request, env: Env): Promise<Response> {
  try {
    if (env.DISABLED === "1") throw new ApiError(503, "DISABLED", "Crawler Free is temporarily disabled");
    const { pathname, hostname: host, origin, searchParams } = new URL(req.url);
    if (req.method === "POST" || req.method === "DELETE") { // before rate limiting, so refused requests cost nothing
      if (fromOtherSite(req, origin)) throw new ApiError(403, "CROSS_SITE_BLOCKED", "requests from other websites' pages are not accepted; call the API from a server, script or terminal");
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
        await req.body?.cancel().catch(() => {}); // tell the sender to stop instead of leaving its upload hanging
        throw tooLarge();
      }
    }
    const client = clientKey(req.headers.get("cf-connecting-ip") ?? "unknown");
    if (req.method === "POST" && pathname === "/v2/scrape") {
      assertShared("page-reads", SHARED.pageReads); // already known to be used up today: refuse before anything else
      const warn: string[] = [];
      const body = await readBody(req, ["url", "formats"], warn);
      const f = parseFormats(body.formats, warn);
      checkUrl(body.url, host); // the address's shape only (no network); a refused request has spent nothing
      await pageRead(env.DB, client);
      const { doc, hit } = await scrape(env, body.url, f, host, client, freshRead(env.DB));
      if (warn.length) doc.warning = warn.join("; ");
      return json(200, { success: true, data: doc }, { "x-cache": hit ? "HIT" : "MISS" });
    }
    if (req.method === "POST" && pathname === "/v2/crawl") {
      // Today's shared crawl-page budget first (a read), then 5 a day per connection and 10 per network (IPv4 /24, IPv6 /48).
      // Pages are charged to the shared budget as they are queued (claim() in crawl.ts).
      // The request is checked before either limit, so a malformed or refused one spends nothing (audit finding B).
      await sharedLeft(env.DB, "crawl-pages", SHARED.crawlPages);
      const warn: string[] = [];
      const body = await readBody(req, ["url", "limit", "maxDiscoveryDepth", "scrapeOptions"], warn);
      const so = (body.scrapeOptions ?? {}) as Record<string, unknown>;
      const extra = Object.keys(so).filter((k) => k !== "formats");
      if (extra.length) warn.push(`ignored unsupported scrapeOptions: ${extra.join(", ")}`);
      const lim = clamp(body.limit, 10, 1, 100, "limit", warn), depth = clamp(body.maxDiscoveryDepth, 2, 0, 3, "maxDiscoveryDepth", warn);
      const f = parseFormats(so.formats, warn, false);
      checkUrl(body.url, host);
      await rateLimit(env.DB, "crawl", client, 5, 86400);
      await rateLimit(env.DB, "crawl-net", subnetKey(client), 10, 86400);
      const started = await startCrawl(env, body.url, lim, depth, f, host, origin);
      return json(200, { ...started, ...(warn.length && { warning: warn.join("; ") }) });
    }
    if (req.method === "POST" && pathname === "/v2/setups") {
      await rateLimit(env.DB, "setup", client, 20, 86400);
      const warn: string[] = [];
      const body = await readBody(req, ["url", "mode", "fields"], warn);
      return json(200, { ...(await createSetup(env, body, host, origin)), ...(warn.length && { warning: warn.join("; ") }) });
    }
    const [, kind, sid] = pathname.match(/^\/(run|v2\/setups)\/([a-z0-9]{10})$/) ?? [];
    if (sid && kind === "v2/setups" && req.method === "DELETE") {
      await rateLimit(env.DB, "delete", client, 30, 60);
      await env.DB.prepare("DELETE FROM setups WHERE id = ?").bind(sid).run();
      return json(200, { success: true });
    }
    if (sid && kind === "run" && req.method === "GET") { // one-step re-run of a saved setup; same limits as a scrape
      assertShared("page-reads", SHARED.pageReads);
      const s = await loadSetup(env, sid); // an unknown setup spends nothing
      await pageRead(env.DB, client);
      const { doc, hit } = await runSetup(env, s, host, client, freshRead(env.DB));
      const headers = { "x-cache": hit ? "HIT" : "MISS" };
      if (searchParams.get("format") === "json") return json(200, { success: true, data: doc }, headers);
      return new Response(asText(doc, s.mode), { headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
    }
    const id = pathname.startsWith("/v2/crawl/") ? pathname.slice(10) : "";
    if (req.method === "GET" && /^[0-9a-f-]{36}$/.test(id)) {
      // Status polls: 60 a minute and 2,000 a day per connection (the SDK polls every 2 s, the web page every 3 s).
      // One poll reads up to ~200 D1 rows, and D1's 5M free reads a day are shared by every request.
      await rateLimit(env.DB, "poll", client, 60, 60);
      await rateLimit(env.DB, "poll-day", client, 2000, 86400);
      const skip = Math.min(100, Math.max(0, parseInt(searchParams.get("skip") ?? "0") || 0)); // a job holds at most 100 pages
      return json(200, await crawlStatus(env, id, skip, origin));
    }
    throw new ApiError(404, "NOT_FOUND", `no route ${req.method} ${pathname}`);
  } catch (e) {
    if (!(e instanceof ApiError)) console.error(e);
    const err = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN_ERROR", "internal error");
    return json(err.status, { success: false, code: err.code, error: err.message }, err.headers);
  }
}

export default {
  async fetch(req, env): Promise<Response> {
    const res = await handle(req, env);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },

  async queue(batch, env) {
    if (env.DISABLED === "1") return; // kill switch also stops queued crawl fetches (messages are dropped)
    // A busy browser is retried 15-30 s later (jittered so busy pages don't collide again), up to 5 attempts.
    for (const m of batch.messages) await crawlPage(env, m.body, m.attempts < 5 ? () => m.retry({ delaySeconds: 15 + Math.floor(Math.random() * 16) }) : undefined);
  },

  async scheduled(_ctl, env) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      ...["counters WHERE reset", "cache WHERE expires", "robots WHERE expires"].map((t) => env.DB.prepare(`DELETE FROM ${t} < ?`).bind(now)),
      env.DB.prepare("DELETE FROM pages WHERE job IN (SELECT id FROM jobs WHERE created < ?)").bind(now - 86400),
      env.DB.prepare("DELETE FROM jobs WHERE created < ?").bind(now - 86400),
      env.DB.prepare("DELETE FROM setups WHERE last_run < ?").bind(now - SETUP_TTL),
    ]);
  },
} satisfies ExportedHandler<Env, CrawlMsg>;
