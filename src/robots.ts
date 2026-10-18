import robotsParser from "robots-parser";
import { ApiError, safeFetch, UA } from "./guard";

const TTL = 3600; // RFC 9309 allows up to 24 h; 1 h keeps policy changes fresh.
const DISALLOW_ALL = "User-agent: *\nDisallow: /";

// RFC 9309: 2xx = use it, 4xx = no restrictions, 5xx or unreachable = complete disallow.
export function robotsBody(status: number, text: string): string {
  return status >= 200 && status < 300 ? text : status >= 400 && status < 500 ? "" : DISALLOW_ALL;
}

// Per-isolate memo of parsed rules (re-parsing a large robots.txt every request costs CPU); D1 stays the source of truth.
const memo = new Map<string, { exp: number; robot: ReturnType<typeof robotsParser> }>();

export async function robotsFor(db: D1Database, u: URL, selfHost: string) {
  const robotsUrl = `${u.origin}/robots.txt`;
  const now = Math.floor(Date.now() / 1000);
  const hit = memo.get(u.origin);
  if (hit && hit.exp > now) return hit.robot;
  let body = await db.prepare("SELECT body FROM robots WHERE origin = ? AND expires > ?").bind(u.origin, now).first<string>("body");
  if (body === null) {
    try {
      const { res, body: text } = await safeFetch(robotsUrl, selfHost);
      body = robotsBody(res.status, text).slice(0, 500_000); // RFC 9309 minimum to parse; keeps the D1 row < 2 MB
    } catch (e) {
      if (e instanceof ApiError && e.code === "URL_BLOCKED") throw e;
      body = DISALLOW_ALL;
    }
    await db.prepare("INSERT INTO robots (origin, body, expires) VALUES (?1, ?2, ?3) ON CONFLICT (origin) DO UPDATE SET body = ?2, expires = ?3")
      .bind(u.origin, body, now + (body === DISALLOW_ALL ? 300 : TTL)).run(); // retry failures after 5 min
  }
  const robot = robotsParser(robotsUrl, body);
  if (memo.size > 500) memo.clear(); // bound isolate memory
  memo.set(u.origin, { exp: now + 300, robot });
  return robot;
}

export async function assertAllowed(db: D1Database, u: URL, selfHost: string): Promise<void> {
  if (!(await robotsFor(db, u, selfHost)).isAllowed(u.href, UA)) {
    throw new ApiError(403, "ROBOTS_DISALLOWED", `robots.txt disallows ${u.href} for CrawlerFree`);
  }
}
