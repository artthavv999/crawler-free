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
    throw new ApiError(429, "RATE_LIMITED", `${name} is limited to ${max} per ${windowSec}s per client`, { "retry-after": String(row!.reset - now) });
  }
}
