// SSRF guard and the only outbound fetch path for target sites.
export const UA = "CrawlerFree/0.1 (+https://github.com/artthavv999/crawler-free)";
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 5;
const TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

const blocked = (why: string): never => { throw new ApiError(400, "URL_BLOCKED", why); };
const BAD_SUFFIX = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/;
const V4_DENY = "0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/3"
  .split(" ").map((c) => { const [ip, bits] = c.split("/"); return [v4(ip), +bits] as const; });

function v4(ip: string): number {
  return ip.split(".").reduce((n, o) => n * 256 + +o, 0);
}

// An IPv6 address as a 128-bit number; null for anything that isn't 8 hextets (embedded IPv4 forms included).
function v6(ip: string): bigint | null {
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2 || ip.includes(".")) return null;
  const h = halves[0] ? halves[0].split(":") : [], t = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 2 && h.length + t.length > 7) return null;
  const parts = halves.length === 2 ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (parts.length !== 8 || !parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.reduce((n, p) => (n << 16n) | BigInt(parseInt(p, 16)), 0n);
}
const cidr6 = (c: string) => { const [ip, bits] = c.split("/"); return [v6(ip)!, BigInt(bits)] as const; };
const in6 = (n: bigint, [base, bits]: readonly [bigint, bigint]) => n >> (128n - bits) === base >> (128n - bits);
// Allow only global unicast 2000::/3 (so ::1, ::ffff:0:0/96, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96 all fail),
// minus the IANA special-purpose blocks inside it that aren't ordinary internet hosts (registry checked 2026-10-19):
// 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID…), 2001:db8::/32 and 3fff::/20 documentation,
// 2002::/16 6to4 (it can embed any IPv4 address, private ones included).
const V6_GLOBAL = cidr6("2000::/3");
const V6_DENY = "2001::/23 2001:db8::/32 2002::/16 3fff::/20".split(" ").map(cidr6);

export function isPublicIp(ip: string): boolean {
  if (ip.includes(":")) {
    const n = v6(ip);
    return n !== null && in6(n, V6_GLOBAL) && !V6_DENY.some((c) => in6(n, c));
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const n = v4(ip);
  return V4_DENY.every(([base, bits]) => n >>> (32 - bits) !== base >>> (32 - bits));
}

// Everything decidable from the URL alone. WHATWG URL already turns 127.1, 2130706433 and 0x7f000001 into 127.0.0.1.
export function checkUrl(raw: string, selfHost = ""): URL {
  let u: URL;
  try { u = new URL(raw); } catch { return blocked("invalid URL"); }
  const host = u.hostname.replace(/\.$/, "");
  if (u.protocol !== "http:" && u.protocol !== "https:") blocked("only http and https URLs are allowed");
  if (!["", "80", "443"].includes(u.port)) blocked("only ports 80 and 443 are allowed");
  if (u.username || u.password) blocked("URLs with credentials are not allowed");
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) blocked("IP-literal hosts are not allowed");
  if (!host.includes(".") || BAD_SUFFIX.test(host) || host === selfHost) blocked("non-public host");
  return u;
}

// Resolve via DoH and require every A/AAAA answer to be globally routable.
// Residual risk: Workers can't pin the resolved IP, so DNS rebinding between this check and fetch() remains.
// Hosts that passed are memoised per isolate for 60 s: each DoH round trip costs CPU (robots + page = 4 lookups).
const dnsOk = new Map<string, number>();
async function checkDns(host: string): Promise<void> {
  if ((dnsOk.get(host) ?? 0) > Date.now()) return;
  const answers = (await Promise.all(["A", "AAAA"].map(async (type) => {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" } });
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
    return (j.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
  }))).flat();
  if (!answers.length) blocked("host does not resolve");
  if (!answers.every(isPublicIp)) blocked("host resolves to a non-public address");
  if (dnsOk.size > 1000) dnsOk.clear(); // bound isolate memory
  dnsOk.set(host, Date.now() + 60_000);
}

// The key used for dedupe and caching.
export function normUrl(raw: string | URL): string {
  const u = new URL(raw);
  u.hash = "";
  if (u.search) u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/index\.(html?|php)$/, "/");
  return u.href;
}

// GET with manual redirects; every hop is re-validated and passed to onHop (robots) before it is fetched.
export async function safeFetch(raw: string, selfHost: string, onHop?: (u: URL) => Promise<void>) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = checkUrl(raw, selfHost);
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      await checkDns(url.hostname);
      await onHop?.(url);
      const res = await fetch(url, { redirect: "manual", signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel();
        url = checkUrl(new URL(loc, url).href, selfHost);
        continue;
      }
      if (+(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw tooBig();
      // shortcut: decoded as UTF-8 regardless of charset; add TextDecoder(charset) if non-UTF-8 sites matter.
      return { res, url, body: await readCapped(res.body, MAX_BYTES, tooBig) };
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "TimeoutError") throw new ApiError(408, "SCRAPE_TIMEOUT", `no response within ${TIMEOUT_MS / 1000}s`);
    throw new ApiError(500, "SCRAPE_FAILED", `fetch failed: ${(e as Error).message}`);
  }
  throw new ApiError(500, "SCRAPE_FAILED", `more than ${MAX_HOPS} redirects`);
}

const tooBig = () => new ApiError(500, "SCRAPE_FAILED", `page larger than ${MAX_BYTES / 1024 / 1024} MB`);

// Reads a body as text and stops with `tooBig()` once it passes `max` bytes. Declared lengths can't be trusted:
// chunked bodies don't declare one. Used for fetched pages and for API request bodies.
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number, tooBig: () => Error): Promise<string> {
  if (!body) return "";
  let n = 0;
  const capped = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) { (n += chunk.byteLength) > max ? ctl.error(tooBig()) : ctl.enqueue(chunk); },
  }));
  return new Response(capped).text().catch((e) => { throw n > max ? tooBig() : e; });
}
