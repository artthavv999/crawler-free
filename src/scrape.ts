import { ApiError, checkUrl, normUrl, safeFetch, UA } from "./guard";
import { extractJson, type JsonFormat } from "./json";
import { assertAllowed } from "./robots";
import type { Env } from "./index";

export type Formats = { markdown?: boolean; links?: boolean; json?: JsonFormat };
export type Doc = { markdown?: string; links?: string[]; warning?: string; metadata: Record<string, unknown> };

const CACHE_TTL = 3600;
// D1 rows max out at 2 MB of UTF-8; String.length counts UTF-16 units, so CJK text can be 3x larger in bytes.
export const fitsRow = (s: string) => new TextEncoder().encode(s).length < 1_900_000;
const RENDER_BELOW_WORDS = 10; // quotes.toscrape.com/js/ extracts 0 words statically, example.com 25

// Page chrome and hidden content are dropped natively by HTMLRewriter (Firecrawl-style selector categories, no scoring);
// hidden-content rules follow Scrapling's sanitizer (THIRD_PARTY_NOTICES.md) but are case/space-insensitive and add
// [hidden] and ARIA roles. The cleaned HTML becomes Markdown through whole-string regex passes: per-element and
// per-text JS callbacks cross the JS/native boundary and dominated CPU on Workers Free (10 ms limit).
const STRUCTURAL = new Set(["html", "body", "main", "article"]); // Wikipedia's <body> class list contains "main-menu-…"
const DROP = [
  "head title script style noscript template svg math iframe canvas object select button nav dialog".split(" "),
  "[hidden]", '[aria-hidden="true" i]',
  "navigation banner contentinfo complementary dialog alertdialog menu menubar search".split(" ").map((r) => `[role="${r}" i]`),
].flat().join(",");
// <header>/<footer>/<aside> are page chrome only at page level (HTML landmark rules). Inside these they hold content:
// post titles, bylines, notes (WordPress puts every post title in <main><section>…<header class="entry-header">).
const IN_CONTENT = "article header,article footer,article aside,section header,section footer,section aside,main header,main footer";
const CHROME_WORDS = "nav menu dropdown sidebar header footer breadcrumb cookie consent share social popup modal overlay newsletter advert banner skip jump editsection".split(" ");
const CHROME_SEL = CHROME_WORDS.flatMap((w) => [`[class*="${w}" i]`, `[id*="${w}" i]`]).join(",");
// Confirms a CHROME_SEL substring hit is chrome: a token that starts with a chrome word ("sidebar-left", "nav-links"),
// ends with an unambiguous one ("main-nav", "dropdown-menu", "mw-editsection"), or is "site-header"/"site-footer".
// Not "has-sidebar", "entry-header", "card-footer", "canvas" or "shared": those wrap or hold real content.
const CHROME = /(^|\s)(nav|navbar|navigation|menu|dropdown|sidebar|header|footer|breadcrumbs?|cookies?|consent|share|sharing|social|popup|modal|overlay|newsletter|advert|banner|skip|jump)([-_\s]|$)|[-_](nav|navbar|navigation|menu|dropdown|breadcrumbs?|editsection|jump-link|skip-link)(\s|$)|(^|\s)(site|global)-(header|footer)(\s|$)/i;
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d])/i;
const TAG = /<(?:"[^"]*"|'[^']*'|[^'">])*>/g; // allows ">" inside quoted attribute values
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i; // leading \s skips data-href
const SRC = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const ALT = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const BLOCK = /<\/?(?:p|div|section|article|main|table|blockquote|figure|figcaption|ul|ol|dl|dt|dd|details|summary|address)\b[^>]*>/gi;
const N = "\x01"; // a Markdown newline, kept apart from source whitespace until that is collapsed
// Zero-width, soft hyphen, bidi controls and C0 controls except tab/LF/CR.
const INVISIBLE = /[\u200b-\u200f\u00ad\u2060-\u2064\ufeff\u180e\u202a-\u202e\u2066-\u2069\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const clean = (s: string) => s.replace(INVISIBLE, "");
// HTMLRewriter hands over raw text and attribute values undecoded.
// shortcut: only common named entities are decoded; add the full HTML5 table if pages show raw &name; text.
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", pound: "£", euro: "€", middot: "·" };
const decode = (s: string) => s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] !== "#") return ENT[e.toLowerCase()] ?? m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});
const ogKey = (p: string) => "og" + p.slice(3).replace(/(^|[_:])(\w)/g, (_m: string, _s: string, c: string) => c.toUpperCase());
const attr = (tag: string, re: RegExp) => { const m = tag.match(re); return m ? decode(m[1] ?? m[2] ?? m[3]) : ""; };

// shortcut: ordered lists become "-" bullets, tables have no header separator, blockquotes are plain paragraphs and
// Markdown characters are not escaped; upgrade when a caller needs GFM-exact output.
// shortcut: regex passes are O(n^2) on pathological markup (thousands of unclosed <a>); the 5 MB cap and the CPU
// limit bound it to that one request; switch to streaming conversion if 1102 errors appear in logs.
export async function extract(html: string, url: URL) {
  const meta: Record<string, string> = {};
  let title = "", base = url, inContent = false;
  const cleaned = await new HTMLRewriter()
    .on("base[href]", { element: (el) => { try { base = new URL(decode(el.getAttribute("href")!), url); } catch { /* keep page URL */ } } })
    .on("html", { element: (el) => { meta.language = el.getAttribute("lang") ?? ""; } })
    .on("title", { text: (t) => { title += t.text; } })
    .on("meta", { element: (el) => {
      const k = el.getAttribute("property") ?? el.getAttribute("name") ?? "", v = decode(el.getAttribute("content") ?? "");
      if (k === "description" || k.startsWith("og:")) meta[k === "description" ? k : ogKey(k)] ??= v;
    } })
    .on(DROP, { element: (el) => { el.remove(); } })
    // Both handlers fire for the same element in this order: the first flags in-content ones, the second consumes it.
    .on(IN_CONTENT, { element: () => { inContent = true; } })
    .on("header,footer,aside", { element: (el) => { if (!inContent) el.remove(); inContent = false; } })
    .on(CHROME_SEL, { element: (el) => {
      if (!STRUCTURAL.has(el.tagName) && CHROME.test(`${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`)) el.remove();
    } })
    .on("[style]", { element: (el) => { if (HIDDEN_STYLE.test(el.getAttribute("style")!)) el.remove(); } })
    .transform(new Response(html))
    .text();

  const abs = (h: string) => { h = h.trim(); try { return h && !h.startsWith("#") ? new URL(h, base).href : ""; } catch { return ""; } };
  const links = new Set<string>(); // from the whole page, including nav and hidden parts
  for (const [t] of html.matchAll(/<a\s(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) { const h = abs(attr(t, HREF)); if (/^https?:/.test(h)) links.add(h); }

  const pres: string[] = [];
  let md = cleaned
    .replace(/[\x00\x01]/g, "") // reserved below as placeholders; page text must not forge them
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, c: string) => `\x00${pres.push(decode(c.replace(TAG, "")).replace(/^\n+|\n+$/g, "")) - 1}\x00`)
    .replace(/<(i|b|em|strong|span|a|code)\b[^>]*>\s*<\/\1>/gi, "") // icon <i></i>, empty links
    .replace(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, (t) => { const s = abs(attr(t, SRC)); return /^https?:/.test(s) ? `![${attr(t, ALT)}](${s})` : ""; })
    .replace(/<a\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/a>/gi, (_m, a: string, inner: string) => {
      const h = abs(attr(a, HREF));
      return /^https?:/.test(h) && inner.trim() ? `[${inner}](${h})` : inner;
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `${N}${N}${"#".repeat(+n)} `)
    .replace(/<\/h[1-6]>/gi, N + N)
    .replace(/<li\b[^>]*>/gi, `${N}- `)
    .replace(BLOCK, N + N)
    .replace(/<tr\b[^>]*>/gi, N)
    .replace(/<t[dh]\b[^>]*>/gi, "| ")
    .replace(/<br\b[^>]*>/gi, N)
    .replace(/<hr\b[^>]*>/gi, `${N}${N}---${N}${N}`)
    .replace(/<\/?(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/?(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/?code\b[^>]*>/gi, "`")
    .replace(TAG, "");
  md = decode(md).replace(/\s+/g, " ").replace(/ ?\x01 ?/g, "\n").replace(/\n{3,}/g, "\n\n")
    .replace(/\x00(\d+)\x00/g, (_m, i: string) => "\n\n```\n" + pres[+i] + "\n```\n\n").replace(/\n{3,}/g, "\n\n").trim();
  const metadata = Object.fromEntries(Object.entries({ title: decode(title), description: "", ...meta }).map(([k, v]) => [k, clean(v).replace(/\s+/g, " ").trim()]));
  return { markdown: clean(md), links: [...links], words: md.match(/\S+/g)?.length ?? 0, metadata };
}

// Browser Run /content: rendered HTML for JS shells, fed through the same pipeline. Free plan: 1 request / 10 s, 10 min/day.
async function render(env: Env, url: URL): Promise<string> {
  const exhausted = () => new ApiError(503, "RENDER_BUDGET_EXHAUSTED", "page needs JavaScript rendering, which is unavailable or out of free daily budget; retry later");
  if (!env.CF_ACCOUNT_ID || !env.CF_BROWSER_TOKEN) throw exhausted();
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-run/content`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_BROWSER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ url: url.href, userAgent: UA, gotoOptions: { waitUntil: "networkidle0" }, rejectResourceTypes: ["image", "media", "font", "stylesheet"] }),
  });
  if (r.status === 429) throw exhausted();
  const j = (await r.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: { code?: number; message?: string }[] };
  if (!j.success || typeof j.result !== "string") {
    const why = j.errors?.map((e) => `${e.code}: ${e.message}`).join("; ").slice(0, 200) ?? "";
    throw new ApiError(500, "SCRAPE_FAILED", `browser rendering failed (${r.status}${why && ` ${why}`})`);
  }
  return j.result;
}

export async function scrape(env: Env, rawUrl: string, f: Formats, selfHost: string): Promise<{ doc: Doc; hit: boolean }> {
  const norm = normUrl(checkUrl(rawUrl, selfHost));
  const key = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([norm, f]))))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);
  const cached = await env.DB.prepare("SELECT body FROM cache WHERE k = ? AND expires > ?").bind(key, now).first<string>("body");
  if (cached) return { doc: JSON.parse(cached), hit: true };

  const { res, url, body } = await safeFetch(rawUrl, selfHost, (u) => assertAllowed(env.DB, u, selfHost));
  if ([401, 402, 403, 429].includes(res.status) || res.headers.get("cf-mitigated") === "challenge") {
    throw new ApiError(403, "BLOCKED", `${url.host} refused the request (HTTP ${res.status}); not retrying`);
  }
  const type = res.headers.get("content-type") ?? "text/html";
  if (!/html|text\/plain/i.test(type)) throw new ApiError(500, "SCRAPE_FAILED", `unsupported content type ${type}`);
  let page = await extract(body, url);
  if (res.ok && page.words < RENDER_BELOW_WORDS && /<script/i.test(body)) page = await extract(await render(env, url), url);

  const doc: Doc = {
    ...(f.markdown && { markdown: page.markdown }),
    ...(f.links && { links: page.links }),
    ...(f.json && { json: await extractJson(env, page.markdown, f.json) }),
    metadata: { ...page.metadata, sourceURL: rawUrl, url: url.href, statusCode: res.status, proxyUsed: "basic" },
  };
  const json = JSON.stringify(doc);
  if (fitsRow(json)) { // best effort: a cache write must never fail a scrape that already succeeded
    await env.DB.prepare("INSERT OR REPLACE INTO cache (k, body, expires) VALUES (?, ?, ?)").bind(key, json, now + CACHE_TTL).run().catch((e) => console.error(e));
  }
  return { doc, hit: false };
}
