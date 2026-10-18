// Crawler Free web page. Everything from the API is shown with textContent, never as HTML.
const $ = (id) => document.getElementById(id);
const form = $("form");
const SAVED_KEY = "crawler-free-setups";
let lastText = "";
let lastName = "result";

const mode = () => form.querySelector('input[name="mode"]:checked').value;
const fieldList = () => $("fields").value.split(",").map((f) => f.trim()).filter(Boolean);
const withScheme = (u) => (u && !/^https?:\/\//i.test(u) ? `https://${u}` : u);

function say(message, isError = false) {
  $("status").textContent = message;
  $("status").className = isError ? "error" : "";
}

function show(text, name) {
  lastText = text;
  lastName = name;
  $("out").textContent = text || "(nothing found on this page)";
  $("result").hidden = false;
}

// Same plain text the /run/<id> link returns.
function asText(data, m) {
  if (m === "links") return (data.links || []).join("\n");
  if (m === "facts") return Object.entries(data.json || {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  return data.markdown || "";
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

async function readPage(url, m) {
  const formats = m === "links" ? ["links"] : m === "facts" ? [{ type: "json", schema: factsSchema(fieldList()) }] : ["markdown"];
  const { data } = await post("/v2/scrape", { url, formats });
  show(asText(data, m), m);
  return "Done.";
}

async function readSite(url) {
  const job = await post("/v2/crawl", { url, limit: Number($("limit").value) || 10 });
  let s;
  do {
    await new Promise((r) => setTimeout(r, 3000));
    s = await call(job.url);
    say(`Reading the website: ${s.completed} of ${s.total} pages done…`);
  } while (s.status === "scraping");
  const pages = [...s.data];
  while (s.next) { s = await call(s.next); pages.push(...s.data); }
  show(pages.map((p) => `# ${p.metadata?.sourceURL ?? ""}\n\n${p.markdown || ""}`).join("\n\n---\n\n"), "website");
  return `Done: ${pages.length} pages.`;
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
    $("result").hidden = true;
    say(mode() === "site" ? "Starting…" : "Reading the page…");
    say(mode() === "site" ? await readSite(url) : await readPage(url, mode()));
  } catch (err) {
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

// Saved setups: the server keeps the settings, this browser keeps the list.
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch { return []; }
}
function storeSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* private mode: list lasts until reload */ }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label, onClick) {
  const b = el("button", "secondary", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
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
  try {
    const { data } = await call(`${s.run}?format=json`);
    show(asText(data, s.mode), s.mode);
    say("Done.");
  } catch (err) {
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

$("copy").addEventListener("click", () => copy(lastText, "Result copied."));
$("download").addEventListener("click", () => {
  const a = el("a", "");
  a.href = URL.createObjectURL(new Blob([lastText], { type: "text/plain;charset=utf-8" }));
  a.download = `crawler-free-${lastName}.${lastName === "text" || lastName === "website" ? "md" : "txt"}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

renderSaved();
