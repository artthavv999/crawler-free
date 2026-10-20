import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import schema from "../schema.sql?raw";
import { checkUrl, normUrl } from "../src/guard";
import type { Env } from "../src/index";
import { asText, forTerminal } from "../src/setups";

// Audit finding C (docs/beginner-cli-plan.md): GET /run/{id} answers plain text that PowerShell's irm or curl prints
// straight into a terminal, so nothing in it may steer the terminal. ?format=json keeps the data exactly.
const BASE = "https://crawler-free.example";
const db = () => (env as unknown as Env).DB;

const NASTY = "Price\u001b]0;pwned\u0007 £5\u001b[2J\u009b31m red\r\nnext\roverwrite‮evil​joined\tTab";

beforeAll(async () => { await db().exec(schema); });

it("removes escape sequences, C1 controls, bidi overrides and zero-width characters, and turns carriage returns into newlines", () => {
  expect(forTerminal(NASTY)).toBe("Price]0;pwned £5[2J31m red\nnext\noverwriteeviljoined\tTab");
  expect(forTerminal("£19.99 — café\nline two")).toBe("£19.99 — café\nline two");
  expect(forTerminal(NASTY)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

it("cleans every kind of saved-setup answer, AI facts included", () => {
  expect(asText({ markdown: NASTY, metadata: {} }, "text")).toBe(forTerminal(NASTY));
  expect(asText({ links: ["https://example.com/a", "https://example.com/b\u001b[2J"], metadata: {} }, "links")).toBe("https://example.com/a\nhttps://example.com/b[2J");
  const facts = { json: { price: "£5\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007", stock: 3 }, metadata: {} };
  expect(asText(facts as never, "facts")).toBe("price: £5]8;;https://evil.exampleclick]8;;\nstock: 3");
});

it("a /run answer is clean as text and exact as JSON", async () => {
  const now = Math.floor(Date.now() / 1000);
  await db().prepare("INSERT INTO setups (id, url, mode, fields, created, last_run) VALUES (?, ?, ?, ?, ?, ?)").bind("nastysetup", "https://example.com/nasty", "text", "[]", now, now).run();
  const data = new TextEncoder().encode(JSON.stringify([normUrl(checkUrl("https://example.com/nasty", "crawler-free.example")), { markdown: true }]));
  const key = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db().prepare("INSERT INTO cache (k, body, expires) VALUES (?, ?, ?)").bind(key, JSON.stringify({ markdown: NASTY, metadata: {} }), now + 3600).run();

  const text = await SELF.fetch(`${BASE}/run/nastysetup`, { headers: { "cf-connecting-ip": "198.51.100.20" } });
  expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await text.text()).toBe(forTerminal(NASTY));
  const json = await SELF.fetch(`${BASE}/run/nastysetup?format=json`, { headers: { "cf-connecting-ip": "198.51.100.20" } });
  expect((await json.json() as { data: { markdown: string } }).data.markdown).toBe(NASTY);
});
