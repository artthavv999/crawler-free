# Crawler Free UI redesign: Phase 0 notes

Read-only audit. No UI code has been written. Backend, API, env and deploy files stay untouched.

## a) Functional contract (must be preserved)

**How the page is built and served**
- No framework and no build step. `public/index.html` loads `public/style.css` and `public/app.js` (`defer`). Cloudflare Workers Static Assets serves `public/` (`wrangler.toml` → `[assets] directory = "./public"`); every other path falls through to the Worker API.
- `public/_headers` sets a strict CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'`. That means no inline `<script>`/`<style>`, no CDNs and no Google Fonts: everything must be self-hosted. JS may still set `element.style.*` (GSAP and Lenis do this, which is allowed).

**API calls the page makes** (same-origin, JSON, errors are `{success:false, code, error}`)

| Action | Call | Response used |
|---|---|---|
| Page text | `POST /v2/scrape {url, formats:["markdown"]}` | `data.markdown` |
| All the links | `POST /v2/scrape {url, formats:["links"]}` | `data.links[]` |
| Specific facts | `POST /v2/scrape {url, formats:[{type:"json", schema:{type:"object", properties:{<name>:{type:"string"}}}}]}` | `data.json` |
| Whole website | `POST /v2/crawl {url, limit 1–100 (default 10)}`, then `GET job.url` every 3 s while `status === "scraping"`, then follow `next` | `data[].markdown`, `data[].metadata.sourceURL` |
| Save setup | `POST /v2/setups {url, mode: text\|links\|facts, fields[]}` | `{id, run, url, mode, fields}` |
| Run setup | `GET {run}?format=json` | `data` (same shape as scrape) |
| Remove setup | `DELETE /v2/setups/{id}` | — |

Every scrape response also carries `data.metadata` (`title, description, language, sourceURL, url, statusCode, proxyUsed`, plus `og*` when present) and an `x-cache: HIT|MISS` header. **The backend returns no HTML format**, so there will be no HTML tab.

**Behaviour that must survive**
- Input: an address without a scheme gets `https://` added. Facts are split on commas and trimmed, and spaces become `_`. Errors appear for an empty address or empty facts.
- Loading: **Go** is disabled during a request. The status line reads "Reading the page…" or "Reading the website: X of Y pages done…".
- Errors: the server's `error` text is shown inline in the status line (`role="status"`, red). Rate-limit messages are already plain English.
- Results: inserted with `textContent` only, never as HTML (prevents XSS from scraped pages). **Copy** puts the text on the clipboard. **Download** saves `crawler-free-<mode>.md|.txt`. A crawl's pages are joined as `# <sourceURL>` + Markdown, separated by `---`.
- Saved setups: kept in `localStorage["crawler-free-setups"]` as `[{id, run, url, mode, fields}]`, newest first. Each setup has **Run**, **Copy link**, **Copy terminal command** (`irm <run>`) and **Remove**. **Save** is hidden in whole-website mode. Existing saved setups must keep working.
- Element IDs used by `app.js`: `form url fields facts-box limit site-box go save status result out copy download saved setups`, plus radios `name="mode"` with values `text|links|facts|site`. I'll keep these IDs on the equivalent new elements.
- **Labels GUIDE.md quotes** (keep the exact wording): "Web page address", "What do you want?", "The page's text", "All the links", "Specific facts", "The whole website", "How many pages", "Go", "Save as a one-click setup", "Your saved setups", "Run", "Copy link", "Copy terminal command", "Remove", "Copy", "Download".

## b) Patterns extracted from the references (feel only, nothing copied)

Measured in the built-in browser at 1440px and 390px, using the live DOM, computed CSS and the Web Animations API. Ref 5 renders entirely in WebGL, so I observed it from screenshots of each phase plus pointer and wheel tests.

**Ref 1: features & tabs (Wix "Tech Company (Dark)")**
- No real tablist. Features are a **2×2 staggered card grid**: two columns, about 315px apart, with the right column offset about 107px lower. At 390px they stack in one column.
- **Scroll-linked tilt-in:** each card starts rotated in 3D (`matrix3d` with perspective, roughly 5–20°) and flattens to `none` by the time it is about two-thirds up the viewport. Later cards start more tilted, which gives a natural stagger.
- Cards: icon, then a mono title (19px), then small mono body text (11px). One family throughout (IBM Plex Mono).
- Interactions are quick: `0.2s linear` on links and buttons, `0.35s ease-in-out` elsewhere.
- Palette: black, mint-white text `rgb(239,255,235)`, one coral accent `rgb(255,96,68)` and sage-grey cards. *Tab mechanics (switching, active indicator) therefore have to come from WAI-ARIA conventions, not from this reference.*

**Ref 2: smoothness & polish (Wix "Digital Marketing Agency (Epic)")**
- Native scrolling: no Lenis or Locomotive (`scroll-behavior: auto`). Smoothness comes from the reveals, not from scroll hijacking.
- **Reveal:** opacity 0→1 plus `translateY(-60px)→0` (it drops in from above), lasting **1.0–1.2s**, eased with `cubic-bezier(0.445,0.05,0.55,0.95)` (ease-in-out sine). It fires as each element enters the viewport.
- **Curtain reveal** for numbered items: `clip-path: polygon(0 0,100% 0,100% 0,0 0)` → full box, together with `translate(0,-100%)→0` and `cubic-bezier(0.645,0.045,0.355,1)`, over 1.2s.
- Hover effects are colour-only: `background-color / border-color / color 0.2s ease-in-out`. Nothing bounces or scales.
- Type: a wide display face at 78px and a grotesk at 60px for sections and 15.6px for body text. At 390px this becomes 40 / 28 / 14px, and the reveals still run.

**Ref 3: minimalism (Wix "Business Consulting (Graphic)")**
- **Two families:** a geometric display sans (600–700 weight) and a humanist sans (light and heavy).
- **Type scale:** 100 / 78 / 40 / 22 / 18 / 16.7 / 15.6 / 14px. Section labels are 18px heavy caps with 0.1em letter spacing. Line height is 0.9 for display, 1.25 for section titles and about 1.4 for body. At 390px: 36 / 24 / 16 / 16px.
- **Colour:** navy text `rgb(22,22,63)`, black and white, with **one accent** (purple `rgb(158,63,253)`) used only 3 times on the page.
- **Whitespace:** sections have 56–88px above them (about 8×8 to 8×11) and 100–150px below, with about 400px under the hero. Text columns are only about 485–530px wide inside a 1440px page.
- Side margins are about 45px on desktop and about 24–62px on phones. The content is left-aligned with lots of empty right-hand space.

**Ref 4: background (Wix "SaaS Company (Innovative)")**
- **Layers:** a solid saturated base `rgb(24,37,170)` (deep blue), then a full-bleed **looping, muted, 12-second abstract video** at **opacity 0.7** (it fades in after load), then the content.
- **Contrast:** white text (400 weight, 80px) sits directly on top, with no shadow and no extra scrim. It stays readable because the dark base caps how bright the video can get (white on the base is about 9.6:1).
- **Motion:** comes only from the video loop. No CSS background animation, no blur filters, no blend modes.
- At 390px the video is **not played** (opacity 0): phones get just the solid base colour.
- Section titles reuse the hue (`rgb(56,86,199)`), so the background colour doubles as the accent.

**Ref 5: interactive UI (igloo.inc)**
- **Preloader:** a flat grey screen with one short line of ASCII characters (`- = +`) cycling in the centre. It isn't skippable and doesn't time out. In the browser pane at about 640px wide it cleared after about 6s; at emulated 1440px and 390px it was still looping after 20–36s. That's the main thing **not** to copy: our preloader must be time-capped and never gate the form.
- **Build-in:** after the loader, a thin white **wireframe of nodes and links draws itself outward** from the centre over about 6–8s. A glow blooms in the middle, then the wireframe resolves into the solid textured scene, spreading outward from the object. This "network lights up, then becomes real" sequence is the idea we adapt as the crawl pulse.
- **Cursor:** the camera eases a few degrees toward the pointer, with heavy damping so it lags about 1s behind. The hero object also reacts to the pointer: its blocks pull apart and settle back. Nothing snaps, and every response is smoothed.
- **Scroll:** the page isn't scrolled at all (`html/body overflow:hidden`, document height = viewport). The wheel drives a **scrubbed camera timeline**: the object reassembles, then the camera descends past it into the next scene. Text panels stay pinned at the corners (logo top-left, copy top-right, a "Scroll down" hint and a "Sound: Off" toggle bottom-left).
- **Text effect:** labels arrive as a **character scramble**: random glyphs settle into the real text left to right in about 1s, in a small monospace face. *Caution:* every word, link and the sound button are drawn inside WebGL. The DOM has 27 elements, no headings, no buttons and no text, so screen readers and keyboard users get nothing. The page also loads about 250 texture, geometry and WASM files. We take the feel and none of this structure: all our text stays real HTML.

## c) Proposal

**Sections (one page, in the brief's order)**
1. **Preloader:** a CSS-only overlay showing a dotted "crawl line" that fills, capped at 1.2s and skippable by click or any key. It's skipped completely on repeat visits (`sessionStorage`/`localStorage` flag). The form is in the DOM and focusable from the start; the overlay is `aria-hidden` and doesn't hold focus.
2. **Hero:** an OGL WebGL graph of about 70 nodes and their links. On load the links draw themselves outward from a seed node within 1.2s (the ref 5 build-in, made much shorter). After that, a "crawl" pulse keeps spreading breadth-first and lighting links in turn. The cursor tilts the camera (±6°) with damped easing, and the nearest node glows. Normal page scroll (no scroll hijacking) dollies the camera back and fades the scene. The small section labels may use a short (≤0.6s) character-scramble reveal: the real text stays in the DOM, and the scramble is skipped under reduced motion. **The URL input, mode choice and Go are the visual focus.** Fallback for mobile, no WebGL or reduced motion: the gradient background plus a static inline SVG of the graph (a few KB).
3. **Result panel:** tabs only for formats that actually came back: **Markdown · Links · JSON** (facts mode only) **· Metadata**, or **Pages** for a whole-website read. Copy and Download act on the active tab. Loading shows the progress line animating, with the text status kept for screen readers. Errors appear inline with the server's message. *To fill several tabs from one request, text and links modes would ask for `["markdown","links"]` together (still one scrape, same limits).*
4. **Features (tabs):** Page text · All the links · Specific facts · Whole website · One-click setups · Developer API. Each panel explains the real behaviour and limits. Inside a panel, cards use ref 1's tilt-in grid.
5. **How it works:** 3 steps (paste an address → it reads politely: robots.txt, SSRF guard, honest User-Agent → get Markdown, links, facts or the whole site), using ref 2's curtain reveal with a 0.12s stagger.
6. **Usage snippets:** a public endpoint exists, so tabs for **cURL / JavaScript (fetch) / Python (requests)**, all calling `POST /v2/scrape`, with Copy.
7. **FAQ:** an accordion, using only real facts: free / no key, limits, robots and blocking, JavaScript pages, data retention, what it won't do. Then a minimal footer: Guide · Source · Report a problem · MIT.

**Design tokens**
- **Colour (dark default):** `--bg #0A0C10`, `--surface #12161D`, `--line #232A35`, `--text #ECEFF4` (about 17:1 on bg), `--muted #9AA4B2` (about 7.5:1), and **one accent** `--accent #6E9BFF` (about 6.9:1 on bg; buttons use bg-coloured text on it, about 6.9:1). Errors `#FF8A7A`.
- **Background (ref 4 pattern, our own build):** base `--bg` → two large accent-tinted radial blobs drifting slowly (40s CSS transform loop, low opacity) → a faint 64px grid (1px lines at 4% opacity, fading out toward the edges) → SVG-noise grain at 5%. Text never sits directly on the brightest blob: panels use `--surface` at 88%. Every text/background pair will be checked for ≥ 4.5:1.
- **Type (max 2):** one display and UI face plus one monospace for output. Scale: 72/40 display, 40/28 h2, 22/20 h3, 17/16 body, 14 small, 12 caps label (0.08em tracking), with line heights 1.0 / 1.15 / 1.6.
- **Spacing:** 8px scale (8 16 24 32 48 64 96 128). Sections get 128px of padding on desktop and 80px on phones. Content is max 1120px wide, with text measure ≤ 640px.
- **Motion:** **one easing curve, `cubic-bezier(0.65, 0.05, 0.36, 1)`.** Durations: 0.4s for hover and tab indicators, 0.6s for panel changes, 0.9s for section reveals, with 0.08–0.12s stagger. Lenis is on for desktop pointer devices only, and everything is instant under `prefers-reduced-motion`.
- **Libraries (pre-approved):** `gsap` + ScrollTrigger (about 45KB gz), `lenis` (about 4KB gz), and **`ogl`** rather than three.js (about 15–25KB gz for the modules used, versus about 150KB). Estimated page JS is about 90KB gz, well under the 300KB budget. Device pixel ratio is capped at 2, and rendering pauses when offscreen (IntersectionObserver) or when the tab is hidden (`visibilitychange`).

## Decisions (approved 2026-10-19: all five as suggested)
1. **Bundling.** gsap, lenis and ogl must be self-hosted (CSP). My suggestion is **esbuild** as a dev-only tool: `npm run build:ui` bundles `ui/` into `public/app.js` plus lazily loaded chunks, which gets committed, so `wrangler deploy` is unchanged. esbuild is already installed under wrangler but isn't a direct dependency, so adding it needs your OK. The alternative is copying each library's ESM files into `public/vendor/` with no bundler, which means more requests but no new tool.
2. **Fonts.** Either self-host two OFL fonts in `public/fonts/` (about 40–60KB woff2 total, for example Space Grotesk + JetBrains Mono), or use system font stacks (0KB, fastest, less distinctive).
3. **Lighthouse.** Either run `npx lighthouse` locally (downloads a new tool, needs your OK), or use Google's PageSpeed Insights website on the live URL (no install; runs Lighthouse mobile remotely).
4. **One request per scrape.** Asking for `["markdown","links"]` together, so both tabs fill from a single request, is the same endpoint with no backend change.
5. **No sound toggle** unless you want one. It isn't in the Phase 1 section list.

## Phase 1 result (built and deployed 2026-10-19)

**What changed:** only the web page. `src/`, `test/`, `schema.sql`, `wrangler.toml` and `public/_headers` are untouched, and the unit tests still pass (11/11).

| Files | What |
|---|---|
| `ui/app.js`, `ui/tabs.js`, `ui/scroll.js` | The reader (same API calls as before), result tabs, WAI-ARIA tabs and accordion |
| `ui/motion.js`, `ui/ease.js` | GSAP + ScrollTrigger reveals, curtains, tilt-in, label scramble; Lenis on desktop; the one shared easing curve |
| `ui/hero.js`, `ui/graph.js` | OGL WebGL web with the crawl pulse; the same graph drawn as the static `public/web.svg` fallback |
| `ui/boot.js`, `ui/build.mjs` | Pre-paint flags (repeat visit, JS on); `npm run build:ui` |
| `public/index.html`, `public/style.css` | New markup and design system (all element IDs and GUIDE.md labels kept) |
| `public/app.js`, `public/boot.js`, `public/chunks/`, `public/web.svg` | Built output, committed so deploys need no build step |
| `public/fonts/`, `public/favicon.svg` | Space Grotesk + JetBrains Mono (latin, OFL texts alongside); icon |

**Dependencies added (devDependencies, exact):** gsap 3.15.0, lenis 1.3.26, ogl 1.0.11, esbuild 0.28.1 (the same version wrangler already ships).

**JavaScript:** 70.3 KB gzipped in total (budget 300 KB). First load needs only `boot.js` (0.1 KB) and `app.js` (4.2 KB); motion (50.4 KB) loads after the page is idle, and the WebGL hero (15.5 KB) only on desktop with WebGL and no reduced-motion setting.

**PageSpeed Insights, mobile (Lighthouse 13.5.0, Moto G Power, slow 4G), live URL, 2026-10-19 12:29 IST:** Performance 96 (budget ≥ 85), Accessibility 100 (budget ≥ 95), Best Practices 100, SEO 100. FCP 1.1 s, LCP 1.5 s (budget < 2.5 s), TBT 0 ms, CLS 0 (budget < 0.1), Speed Index 5.3 s. Report: https://pagespeed.web.dev/analysis/https-crawler-free-crawler-free-workers-dev/rcrgdfvy4q?form_factor=mobile

**Fonts:** `font-display: swap` with fallback faces sized to the real fonts (Arial at 107.46 %, Courier New at 100 %, measured in the browser), so a slow first visit still ends on Space Grotesk and JetBrains Mono. Three throttled headless runs (412 px, slow 4G, 4× CPU) measured CLS 0.

**Verified:**
- Local (wrangler dev): whole-website read of https://example.com through the page, then Markdown and Pages tabs; page text, facts (JSON tab), links, metadata; empty-address and blocked-address errors inline; save → Run → Remove a setup; keyboard: ←/→/Home/End on all tab sets, ↑/↓ and Enter on the FAQ.
- Live, headless Chrome: zero console errors at 1440, 768 and 390 px (load, scroll, a page read). Reduced motion: static hero, no Lenis, no preloader, no motion or WebGL code loaded, all content visible at once, background glow still. No WebGL (`--disable-3d-apis`): static hero and the WebGL chunk never loads.
- Live, 12:59 IST: whole-website read of https://example.com through the page: "Done: 1 page." in 6 s, Markdown and Pages tabs filled, zero console errors (`1440-7-crawl-result.jpg`).
- Screenshots: `docs/screenshots/` (1440/768/390: hero, features, how it works, API, FAQ, a result; plus reduced motion, no WebGL and an inline error).

**Deliberate differences from the old page:**
- Text and links modes now ask for `["markdown","links"]` in one request (approved), and facts mode adds the JSON format to that request, so every tab fills from one scrape. Saved-setup runs are unchanged (the server picks their formats).
- Copy and Download act on the open tab. File names: `crawler-free-text.md`, `-links.txt`, `-website.md` as before; facts now download as `crawler-free-facts.json` (was `.txt`), plus new `-metadata.json` and `-pages.txt`.
- "Done: 1 pages." now reads "Done: 1 page."

**Gaps:**
- Speed Index (5.3 s on emulated slow 4G) is the weakest metric: the first-visit preloader covers the page for about 1.2 s. It is still within the overall Performance budget.
- Lighthouse's diagnostic "non-composited animations" listed the preloader fade, the preloader line and the two tab underlines; all four now animate only opacity or transform (fixed after the run above; diagnostic only, not scored).
