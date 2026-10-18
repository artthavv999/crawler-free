import { ApiError } from "./guard";

// IPv4 as-is; IPv6 collapsed to its /64 so one host can't rotate through its own prefix. IPv4-mapped IPv6
// ("::ffff:1.2.3.4") stays whole: its /64 would put every such client in one bucket.
export function clientKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return full.slice(0, 4).map((x) => parseInt(x, 16).toString(16)).join(":") + "::/64";
}

const LABELS: Record<string, string> = { scrape: "page reads", json: "fact look-ups", crawl: "whole-website reads", setup: "new saved setups" };

// Fixed window that starts at the first request after the previous window ended.
export async function rateLimit(db: D1Database, name: string, key: string, max: number, windowSec: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(
    `INSERT INTO counters (k, n, reset) VALUES (?1, 1, ?2 + ?3)
     ON CONFLICT (k) DO UPDATE SET n = CASE WHEN reset <= ?2 THEN 1 ELSE n + 1 END,
                                   reset = CASE WHEN reset <= ?2 THEN ?2 + ?3 ELSE reset END
     RETURNING n, reset`,
  ).bind(`${name}:${key}`, now, windowSec).first<{ n: number; reset: number }>();
  if (row!.n > max) {
    const wait = row!.reset - now;
    const when = wait < 120 ? `${wait} seconds` : wait < 7200 ? `${Math.ceil(wait / 60)} minutes` : `about ${Math.round(wait / 3600)} hours`;
    const per = windowSec === 60 ? "a minute" : windowSec === 86400 ? "24 hours" : `${windowSec} seconds`;
    throw new ApiError(429, "RATE_LIMITED", `You've used all ${max} ${LABELS[name] ?? name} allowed per ${per}. Try again in ${when}.`, { "retry-after": String(wait) });
  }
}
