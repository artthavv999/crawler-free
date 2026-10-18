import { crawlPage, crawlStatus, startCrawl, type CrawlMsg } from "./crawl";
import { ApiError } from "./guard";
import { clientKey, rateLimit } from "./limits";
import { scrape, type Formats } from "./scrape";

export interface Env {
  DB: D1Database;
  QUEUE: Queue<CrawlMsg>;
  AI: Ai;
  DISABLED?: string;
  CF_ACCOUNT_ID?: string;
  CF_BROWSER_TOKEN?: string;
}

const SILENT = ["origin", "integration"]; // the Firecrawl SDK injects `origin` into every POST

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

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
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "BAD_REQUEST", "body must be a JSON object");
  const extra = Object.keys(body).filter((k) => !known.includes(k) && !SILENT.includes(k));
  if (extra.length) warn.push(`ignored unsupported fields: ${extra.join(", ")}`);
  if (typeof (body as { url?: unknown }).url !== "string") throw new ApiError(400, "BAD_REQUEST", "url is required");
  return body as Record<string, unknown> & { url: string };
}

export default {
  async fetch(req, env): Promise<Response> {
    try {
      if (env.DISABLED === "1") throw new ApiError(503, "DISABLED", "Crawler Free is temporarily disabled");
      const { pathname, hostname: host, origin, searchParams } = new URL(req.url);
      const client = clientKey(req.headers.get("cf-connecting-ip") ?? "unknown");
      if (req.method === "POST" && pathname === "/v2/scrape") {
        await rateLimit(env.DB, "scrape", client, 20, 60);
        const warn: string[] = [];
        const body = await readBody(req, ["url", "formats"], warn);
        const f = parseFormats(body.formats, warn);
        if (f.json) await rateLimit(env.DB, "json", client, 20, 86400);
        const { doc, hit } = await scrape(env, body.url, f, host);
        if (warn.length) doc.warning = warn.join("; ");
        return json(200, { success: true, data: doc }, { "x-cache": hit ? "HIT" : "MISS" });
      }
      if (req.method === "POST" && pathname === "/v2/crawl") {
        // shortcut: no Turnstile gate on crawl/json yet, only per-IP (IPv6 /64) limits; add a Turnstile-minted token
        // if distributed abuse drains the daily Queue/AI budgets.
        await rateLimit(env.DB, "crawl", client, 5, 86400);
        const warn: string[] = [];
        const body = await readBody(req, ["url", "limit", "maxDiscoveryDepth", "scrapeOptions"], warn);
        const so = (body.scrapeOptions ?? {}) as Record<string, unknown>;
        const extra = Object.keys(so).filter((k) => k !== "formats");
        if (extra.length) warn.push(`ignored unsupported scrapeOptions: ${extra.join(", ")}`);
        const lim = clamp(body.limit, 10, 1, 50, "limit", warn), depth = clamp(body.maxDiscoveryDepth, 2, 0, 3, "maxDiscoveryDepth", warn);
        const started = await startCrawl(env, body.url, lim, depth, parseFormats(so.formats, warn, false), host, origin);
        return json(200, { ...started, ...(warn.length && { warning: warn.join("; ") }) });
      }
      const id = pathname.startsWith("/v2/crawl/") ? pathname.slice(10) : "";
      // shortcut: status polls are not rate limited (the SDK polls every 2 s); Workers' 100k requests/day is the cap.
      // Add a per-IP limit if polling dominates the daily request count.
      if (req.method === "GET" && /^[0-9a-f-]{36}$/.test(id)) return json(200, await crawlStatus(env, id, Math.max(0, parseInt(searchParams.get("skip") ?? "0") || 0), origin));
      throw new ApiError(404, "NOT_FOUND", `no route ${req.method} ${pathname}`);
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      const err = e instanceof ApiError ? e : new ApiError(500, "UNKNOWN_ERROR", "internal error");
      return json(err.status, { success: false, code: err.code, error: err.message }, err.headers);
    }
  },

  async queue(batch, env) {
    if (env.DISABLED === "1") return; // kill switch also stops queued crawl fetches (messages are dropped)
    for (const m of batch.messages) await crawlPage(env, m.body);
  },

  async scheduled(_ctl, env) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      ...["counters WHERE reset", "cache WHERE expires", "robots WHERE expires"].map((t) => env.DB.prepare(`DELETE FROM ${t} < ?`).bind(now)),
      env.DB.prepare("DELETE FROM pages WHERE job IN (SELECT id FROM jobs WHERE created < ?)").bind(now - 86400),
      env.DB.prepare("DELETE FROM jobs WHERE created < ?").bind(now - 86400),
    ]);
  },
} satisfies ExportedHandler<Env, CrawlMsg>;
