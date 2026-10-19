import { ApiError } from "./guard";

// Shared daily budgets for everyone, sized against Cloudflare's free allowances (which reset at 00:00 UTC):
// 15,000 page reads ≈ 45k of the 100k D1 rows written per day; 2,500 crawled pages ≈ 7.5k of the 10k queue operations.
// Using one up pauses only that feature until midnight, instead of exhausting D1 and failing every request.
export const SHARED = { pageReads: 15_000, crawlPages: 2_500 };
export const sharedKey = (name: string) => `shared:${name}`; // its row in the counters table

// An IPv6 address as its 8 hextets ("::" expanded), from a raw address or a clientKey() "…::/64".
function hextets(ip: string): string[] {
  const [head, tail = ""] = ip.toLowerCase().replace(/\/\d+$/, "").split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
}
const prefix = (ip: string, n: number) => hextets(ip).slice(0, n).map((x) => parseInt(x || "0", 16).toString(16)).join(":");

// IPv4 as-is; IPv6 collapsed to its /64 so one host can't rotate through its own prefix. IPv4-mapped IPv6
// ("::ffff:1.2.3.4") stays whole: its /64 would put every such client in one bucket.
export function clientKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  return `${prefix(ip, 4)}::/64`;
}

// The network a connection belongs to: its IPv4 /24 or IPv6 /48, the block one site or customer usually gets.
// Limits on it stop one person cycling through the 65,536 /64s of their /48. Accepts a raw IP or a clientKey().
export function subnetKey(ip: string): string {
  if (ip.includes(".")) {
    const v4 = ip.slice(ip.lastIndexOf(":") + 1).split(".");
    return v4.length === 4 ? `${v4.slice(0, 3).join(".")}.0/24` : ip;
  }
  return ip.includes(":") ? `${prefix(ip, 3)}::/48` : ip;
}

const LABELS: Record<string, { what: string; network?: boolean }> = {
  scrape: { what: "page reads" },
  "scrape-day": { what: "page reads" },
  json: { what: "fact look-ups" },
  "json-net": { what: "fact look-ups", network: true },
  crawl: { what: "whole-website reads" },
  "crawl-net": { what: "whole-website reads", network: true },
  setup: { what: "new saved setups" },
  delete: { what: "setup removals" },
  poll: { what: "crawl status checks" },
  "poll-day": { what: "crawl status checks" },
  "page-reads": { what: "page reads" },
  "crawl-pages": { what: "whole-website pages" },
};

const inWords = (wait: number) => wait < 120 ? `${wait} seconds` : wait < 7200 ? `${Math.ceil(wait / 60)} minutes` : `about ${Math.round(wait / 3600)} hours`;
const count = (n: number) => n.toLocaleString("en-US");

// Keys known to be over their limit, until their reset, per isolate: repeat refusals don't touch D1 at all.
const refused = new Map<string, number>();
function remember(k: string, reset: number) {
  if (refused.size > 10_000) refused.clear(); // bound isolate memory
  refused.set(k, reset);
}

function tooMany(name: string, max: number, windowSec: number, wait: number): ApiError {
  const { what, network } = LABELS[name] ?? { what: name };
  const per = windowSec === 60 ? "minute" : windowSec === 86400 ? "24 hours" : `${windowSec} seconds`;
  const message = network
    ? `Connections on your network have used all ${count(max)} ${what} allowed per ${per}. Try again in ${inWords(wait)}.`
    : `You've used all ${count(max)} ${what} allowed per ${per}. Try again in ${inWords(wait)}.`;
  return new ApiError(429, "RATE_LIMITED", message, { "retry-after": String(wait) });
}

// Fixed window that starts at the first request after the previous window ended. The count only goes up while under
// the limit, so a refused request writes nothing (D1 bills rows written, and they are shared by every feature).
export async function rateLimit(db: D1Database, name: string, key: string, max: number, windowSec: number): Promise<void> {
  const k = `${name}:${key}`;
  const now = Math.floor(Date.now() / 1000);
  const known = refused.get(k) ?? 0;
  if (known > now) throw tooMany(name, max, windowSec, known - now);
  const row = await db.prepare(
    `INSERT INTO counters (k, n, reset) VALUES (?1, 1, ?2 + ?3)
     ON CONFLICT (k) DO UPDATE SET n = CASE WHEN reset <= ?2 THEN 1 ELSE n + 1 END,
                                   reset = CASE WHEN reset <= ?2 THEN ?2 + ?3 ELSE reset END
     WHERE reset <= ?2 OR n < ?4
     RETURNING n`,
  ).bind(k, now, windowSec, max).first();
  if (row) return;
  const reset = (await db.prepare("SELECT reset FROM counters WHERE k = ?").bind(k).first<number>("reset")) ?? now + windowSec;
  remember(k, reset);
  throw tooMany(name, max, windowSec, reset - now);
}

const midnight = (now: number) => (Math.floor(now / 86400) + 1) * 86400; // next 00:00 UTC

function budgetGone(name: string, max: number, wait: number): ApiError {
  return new ApiError(503, "DAILY_BUDGET_EXHAUSTED",
    `Today's shared allowance of ${count(max)} ${LABELS[name]?.what ?? name} for everyone is used up. It resets at 00:00 UTC, in ${inWords(wait)}.`,
    { "retry-after": String(wait) });
}

// Refuses at once, without D1, if this isolate already saw the shared budget run out today. Call it before the
// per-connection limits so nobody's own allowance is spent on a request that can't run.
export function assertShared(name: string, max: number): void {
  const now = Math.floor(Date.now() / 1000), known = refused.get(sharedKey(name)) ?? 0;
  if (known > now) throw budgetGone(name, max, known - now);
}

// Spends one unit of a shared daily budget, or refuses with 503 (and writes nothing) once it is used up.
export async function spendShared(db: D1Database, name: string, max: number): Promise<void> {
  assertShared(name, max);
  const k = sharedKey(name), now = Math.floor(Date.now() / 1000), reset = midnight(now);
  const row = await db.prepare(
    `INSERT INTO counters (k, n, reset) VALUES (?1, 1, ?3)
     ON CONFLICT (k) DO UPDATE SET n = CASE WHEN reset <= ?2 THEN 1 ELSE n + 1 END,
                                   reset = CASE WHEN reset <= ?2 THEN ?3 ELSE reset END
     WHERE reset <= ?2 OR n < ?4
     RETURNING n`,
  ).bind(k, now, reset, max).first();
  if (row) return;
  remember(k, reset);
  throw budgetGone(name, max, reset - now);
}

// Units of a shared daily budget still free today (a read, no write). Refuses once none are left.
export async function sharedLeft(db: D1Database, name: string, max: number): Promise<number> {
  assertShared(name, max);
  const now = Math.floor(Date.now() / 1000);
  const used = (await db.prepare("SELECT n FROM counters WHERE k = ? AND reset > ?").bind(sharedKey(name), now).first<number>("n")) ?? 0;
  if (used < max) return max - used;
  remember(sharedKey(name), midnight(now));
  throw budgetGone(name, max, midnight(now) - now);
}

// Records units that were already granted against sharedLeft() (crawl pages queued by claim()).
export async function addShared(db: D1Database, name: string, amount: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    `INSERT INTO counters (k, n, reset) VALUES (?1, ?2, ?4)
     ON CONFLICT (k) DO UPDATE SET n = CASE WHEN reset <= ?3 THEN ?2 ELSE n + ?2 END,
                                   reset = CASE WHEN reset <= ?3 THEN ?4 ELSE reset END`,
  ).bind(sharedKey(name), amount, now, midnight(now)).run();
}
