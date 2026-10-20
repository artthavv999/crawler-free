// Crawler Free web page. Everything from the API is shown with textContent, never as HTML.
// Motion (gsap + lenis) and the WebGL hero (ogl) load later, only where they can run; the reader works without them.
import { bringIntoView, scrollToEl, setScroller } from "./scroll.js";
import { accordion, tabs } from "./tabs.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const SAVED_KEY = "crawler-free-setups";
const PROD = "https://crawler-free.crawler-free.workers.dev";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const mode = () => form.querySelector('input[name="mode"]:checked').value;
const fieldList = () => $("fields").value.split(",").map((f) => f.trim()).filter(Boolean);
const withScheme = (u) => (u && !/^https?:\/\//i.test(u) ? `https://${u}` : u);

function say(message, isError = false) {
  $("status").textContent = message;
  $("status").className = isError ? "error" : "";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label, onClick) {
  const b = el("button", "ghost", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

async function call(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({ success: false, error: `the server answered ${res.status}` }));
  if (!res.ok || body.success === false) throw new Error(body.error || `The server answered ${res.status}.`);
  return body;
}
const post = (path, data) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

function factsSchema(fields) {
  const properties = {};
  for (const f of fields) properties[f.replace(/\s+/g, "_")] = { type: "string" };
  return { type: "object", properties };
}

// ---------- result panel: one tab per format the server returned ----------
let views = [];
let active = null;
const resultTabs = tabs($("result-tabs"), (tab) => { active = views.find((v) => `rt-${v.key}` === tab.id) ?? null; });

function loading(message, progress) {
  const r = $("result");
  const fresh = r.hidden;
  r.hidden = false;
  r.dataset.state = "loading";
  $("result-loading").hidden = false;
  $("loading-text").textContent = message;
  const bar = $("progress");
  bar.hidden = !progress;
  if (progress) {
    const [done, total] = progress;
    bar.setAttribute("aria-valuemax", String(Math.max(total, 1)));
    bar.setAttribute("aria-valuenow", String(done));
    bar.style.setProperty("--p", String(total ? done / total : 0));
  }
  if (fresh) bringIntoView(r);
}

function stopLoading() {
  if ($("result").dataset.state === "loading") $("result").hidden = true;
}

function show(list, first, source) {
  views = list;
  const r = $("result");
  r.hidden = false;
  r.dataset.state = "ready";
  $("result-loading").hidden = true;
  $("result-source").textContent = source;
  const bar = $("result-tabs"), out = $("out");
  bar.replaceChildren();
  out.replaceChildren();
  for (const v of list) {
    const tab = el("button", "", v.label);
    tab.type = "button";
    tab.id = `rt-${v.key}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `rp-${v.key}`);
    if (v.count !== undefined) tab.append(el("span", "count", String(v.count)));
    const panel = el("div", "out-panel");
    panel.id = `rp-${v.key}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.tabIndex = 0;
    const pre = el("pre", "out-pre", v.text || "(nothing found on this page)");
    pre.setAttribute("data-lenis-prevent", "");
    panel.append(pre);
    bar.append(tab);
    out.append(panel);
  }
  resultTabs.select($(`rt-${first}`) ?? bar.querySelector('[role="tab"]'));
}

// Same tab order everywhere; the mode decides which one opens first.
function pageViews(data) {
  const v = [];
  if (data.markdown !== undefined) v.push({ key: "markdown", label: "Markdown", text: data.markdown, file: "crawler-free-text.md" });
  if (data.links !== undefined) v.push({ key: "links", label: "Links", count: data.links.length, text: data.links.join("\n"), file: "crawler-free-links.txt" });
  if (data.json !== undefined) v.push({ key: "json", label: "JSON", text: JSON.stringify(data.json, null, 2), file: "crawler-free-facts.json" });
  if (data.metadata) v.push({ key: "metadata", label: "Metadata", text: JSON.stringify(data.metadata, null, 2), file: "crawler-free-metadata.json" });
  return v;
}
function siteViews(pages) {
  return [
    { key: "markdown", label: "Markdown", text: pages.map((p) => `# ${p.metadata?.sourceURL ?? ""}\n\n${p.markdown || ""}`).join("\n\n---\n\n"), file: "crawler-free-website.md" },
    { key: "pages", label: "Pages", count: pages.length, text: pages.map((p, i) => `${i + 1}. ${p.metadata?.title || "(no title)"}\n   ${p.metadata?.sourceURL ?? ""}`).join("\n"), file: "crawler-free-pages.txt" },
  ];
}
const firstFor = (m) => (m === "links" ? "links" : m === "facts" ? "json" : "markdown");
const sourceOf = (data, url) => [data.metadata?.title, data.metadata?.sourceURL ?? url].filter(Boolean).join(" · ");

// One request fills the Markdown and Links tabs; facts add the JSON tab.
async function readPage(url, m) {
  const formats = ["markdown", "links", ...(m === "facts" ? [{ type: "json", schema: factsSchema(fieldList()) }] : [])];
  const { data } = await post("/v2/scrape", { url, formats });
  show(pageViews(data), firstFor(m), sourceOf(data, url));
  return "Done.";
}

async function readSite(url) {
  const job = await post("/v2/crawl", { url, limit: Number($("limit").value) || 10 });
  let s;
  do {
    await new Promise((r) => setTimeout(r, 3000));
    s = await call(job.url);
    const message = `Reading the website: ${s.completed} of ${s.total} pages done…`;
    say(message);
    loading(message, [s.completed, s.total]);
  } while (s.status === "scraping");
  const pages = [...s.data];
  while (s.next) { s = await call(s.next); pages.push(...s.data); }
  const n = `${pages.length} page${pages.length === 1 ? "" : "s"}`;
  show(siteViews(pages), "markdown", `${n} from ${url}`);
  return `Done: ${n}.`;
}

function checkInputs() {
  const url = withScheme($("url").value.trim());
  if (!url) throw new Error("Paste a web page address first.");
  if (mode() === "facts" && !fieldList().length) throw new Error("Type the facts you want, for example: title, price");
  return url;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("go").disabled = true;
  try {
    const url = checkInputs();
    const site = mode() === "site";
    const message = site ? "Starting…" : "Reading the page…";
    say(message);
    loading(message, site ? [0, 0] : null);
    say(site ? await readSite(url) : await readPage(url, mode()));
  } catch (err) {
    stopLoading();
    say(err.message, true);
  } finally {
    $("go").disabled = false;
  }
});

form.addEventListener("change", () => {
  $("facts-box").hidden = mode() !== "facts";
  $("site-box").hidden = mode() !== "site";
  $("save").hidden = mode() === "site";
});
form.dispatchEvent(new Event("change")); // the browser may restore a mode chosen before a reload

// ---------- saved setups: the server keeps the settings, this browser keeps the list ----------
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch { return []; }
}
function storeSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* private mode: list lasts until reload */ }
}

async function copy(text, message) {
  try { await navigator.clipboard.writeText(text); say(message); } catch { say("Couldn't copy. Select the text and press Ctrl+C.", true); }
}

function renderSaved() {
  const list = loadSaved();
  const ul = $("setups");
  ul.replaceChildren();
  $("saved").hidden = !list.length;
  for (const s of list) {
    const what = s.mode === "facts" ? `Facts: ${s.fields.join(", ")}` : s.mode === "links" ? "All the links" : "The page's text";
    const li = el("li", "setup");
    li.append(el("div", "setup-url", s.url), el("div", "setup-what", what));
    const cmd = el("div", "setup-cmd");
    cmd.append(el("span", "", "Terminal: "), el("code", "", `irm ${s.run}`));
    li.append(cmd);
    const actions = el("div", "setup-actions");
    actions.append(
      button("Run", () => runSaved(s)),
      button("Copy link", () => copy(s.run, "Link copied. Open it in any browser to run this setup.")),
      button("Copy terminal command", () => copy(`irm ${s.run}`, "Command copied. Paste it into PowerShell and press Enter.")),
      button("Remove", () => removeSaved(s)),
    );
    li.append(actions);
    ul.append(li);
  }
}

async function runSaved(s) {
  say("Reading the page…");
  loading("Reading the page…", null);
  try {
    const { data } = await call(`${s.run}?format=json`);
    show(pageViews(data), firstFor(s.mode), sourceOf(data, s.url));
    say("Done.");
  } catch (err) {
    stopLoading();
    say(err.message, true);
  }
}

function removeSaved(s) {
  storeSaved(loadSaved().filter((x) => x.id !== s.id));
  renderSaved();
  fetch(`/v2/setups/${s.id}`, { method: "DELETE" }).catch(() => {});
  say("Setup removed.");
}

$("save").addEventListener("click", async () => {
  try {
    const url = checkInputs();
    const s = await post("/v2/setups", { url, mode: mode(), fields: fieldList() });
    storeSaved([{ id: s.id, run: s.run, url: s.url, mode: s.mode, fields: s.fields }, ...loadSaved()]);
    renderSaved();
    say("Saved. From now on, use Run in “Your saved setups” below, or its link or terminal command.");
  } catch (err) {
    say(err.message, true);
  }
});

$("copy").addEventListener("click", () => copy(active?.text ?? "", "Result copied."));
$("download").addEventListener("click", () => {
  if (!active) return;
  const a = el("a", "");
  a.href = URL.createObjectURL(new Blob([active.text], { type: "text/plain;charset=utf-8" }));
  a.download = active.file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

renderSaved();

// ---------- the rest of the page ----------
tabs(document.querySelector('.feature-tabs [role="tablist"]'));
accordion(document.querySelector(".accordion"));

// "Try it" picks that mode in the reader and puts the cursor in the address box.
for (const b of document.querySelectorAll(".try[data-mode]")) {
  b.addEventListener("click", () => {
    form.querySelector(`input[name="mode"][value="${b.dataset.mode}"]`).checked = true;
    form.dispatchEvent(new Event("change"));
    scrollToEl($("tool"));
    $("url").focus({ preventScroll: true });
  });
}

// Examples show this server's address (self-hosted copies and local dev included).
if (location.origin !== PROD && /^https?:$/.test(location.protocol)) {
  for (const s of document.querySelectorAll("[data-origin]")) s.textContent = location.origin;
}

// Each code card (the terminal commands and the API examples) has tabs and a button that copies the open tab's code.
for (const card of document.querySelectorAll(".snippets")) {
  tabs(card.querySelector('[role="tablist"]'));
  const b = card.querySelector(".copy-code");
  const codeStatus = el("span", "sr-only");
  codeStatus.setAttribute("role", "status");
  b.after(codeStatus);
  b.addEventListener("click", async () => {
    const pre = card.querySelector('[role="tabpanel"]:not([hidden]) pre');
    try {
      await navigator.clipboard.writeText(pre.textContent);
      b.textContent = codeStatus.textContent = "Copied";
    } catch {
      b.textContent = codeStatus.textContent = "Couldn't copy";
    }
    setTimeout(() => { b.textContent = "Copy code"; codeStatus.textContent = ""; }, 1600);
  });
}

const top = $("top");
const onScroll = () => top.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Preloader: CSS plays it once (about 1.2 s) and never blocks input; any key or click skips it.
const pre = document.querySelector(".preloader");
const skip = () => { if (pre.isConnected) pre.classList.add("done"); };
pre.addEventListener("animationend", (e) => { if (e.target === pre) pre.remove(); });
addEventListener("keydown", skip, { once: true });
addEventListener("pointerdown", skip, { once: true });
try { localStorage.setItem("crawler-free-seen", "1"); } catch { /* storage blocked */ }

// Motion and the WebGL hero load after the page is ready, so they never delay the reader.
function hasWebGL() {
  try {
    const gl = document.createElement("canvas").getContext("webgl", { failIfMajorPerformanceCaveat: true });
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}
const heroWebGL = !reduceMotion && matchMedia("(min-width: 900px) and (pointer: fine)").matches && hasWebGL();
document.documentElement.dataset.hero = heroWebGL ? "webgl" : "static";
const idle = (fn) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 200));
const afterLoad = (fn) => (document.readyState === "complete" ? idle(fn) : addEventListener("load", () => idle(fn), { once: true }));
if (!reduceMotion) afterLoad(() => import("./motion.js").then((m) => m.start(setScroller)).catch((e) => console.warn("motion off:", e)));
if (heroWebGL) afterLoad(() => import("./hero.js").then((m) => m.start(document.querySelector(".hero-art"))).catch((e) => console.warn("static hero:", e)));
