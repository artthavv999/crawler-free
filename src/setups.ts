import { ApiError, checkUrl } from "./guard";
import { scrape, type Doc, type Formats } from "./scrape";
import type { Env } from "./index";

// Saved setups: a page address plus what to get from it, stored once and re-run in one step from a short link
// (browser) or `irm <link>` (terminal). They hold settings only, never page content, and expire after 30 days unused.
export type Mode = "text" | "links" | "facts";
type Setup = { id: string; url: string; mode: Mode; fields: string; last_run: number };

const MODES: Mode[] = ["text", "links", "facts"];
export const SETUP_TTL = 30 * 86400;

export const factsSchema = (fields: string[]) => ({ type: "object", properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])) });

const formatsFor = (s: Setup): Formats =>
  s.mode === "links" ? { links: true } : s.mode === "facts" ? { json: { schema: factsSchema(JSON.parse(s.fields)) } } : { markdown: true };

// Plain text so a terminal prints it directly: the page text, one link per line, or "name: answer" lines.
// The terminal is the last stop, so anything that could steer it goes here (audit finding C): control characters other
// than tab and newline (ESC sequences, C1 such as CSI), bidi overrides and zero-width characters are removed, and a
// carriage return becomes a newline so it can't overwrite what's already on screen. AI facts are covered too.
// ?format=json and the cache keep the data exactly.
const TERMINAL_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
export const forTerminal = (text: string) => text.replace(/\r\n?/g, "\n").replace(TERMINAL_UNSAFE, "");
export function asText(doc: Doc, mode: Mode): string {
  if (mode === "links") return forTerminal((doc.links ?? []).join("\n"));
  if (mode === "facts") return forTerminal(Object.entries((doc as { json?: Record<string, unknown> }).json ?? {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n"));
  return forTerminal(doc.markdown ?? "");
}

export async function createSetup(env: Env, body: Record<string, unknown> & { url: string }, self: string, origin: string) {
  checkUrl(body.url, self); // robots.txt and DNS are checked on every run
  const mode = (body.mode ?? "text") as Mode;
  if (!MODES.includes(mode)) throw new ApiError(400, "BAD_REQUEST", `mode must be one of: ${MODES.join(", ")}`);
  const raw = typeof body.fields === "string" ? body.fields.split(",") : Array.isArray(body.fields) ? body.fields : [];
  const fields = [...new Set(raw.map((f) => String(f).trim().replace(/\s+/g, "_")).filter(Boolean))];
  if (mode === "facts" && (!fields.length || fields.length > 20 || fields.some((f) => f.length > 60))) {
    throw new ApiError(400, "BAD_REQUEST", "facts needs 1 to 20 field names, each up to 60 characters");
  }
  const id = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO setups (id, url, mode, fields, created, last_run) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, body.url, mode, JSON.stringify(mode === "facts" ? fields : []), now, now).run();
  return { success: true, id, run: `${origin}/run/${id}`, url: body.url, mode, fields: mode === "facts" ? fields : [] };
}

export async function loadSetup(env: Env, id: string): Promise<Setup> {
  const s = await env.DB.prepare("SELECT id, url, mode, fields, last_run FROM setups WHERE id = ?").bind(id).first<Setup>();
  if (!s) throw new ApiError(404, "NOT_FOUND", "setup not found (setups expire after 30 days without a run)");
  return s;
}

export async function runSetup(env: Env, s: Setup, self: string, client: string, onMiss?: () => Promise<void>): Promise<{ doc: Doc; hit: boolean }> {
  await env.DB.prepare("UPDATE setups SET last_run = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), s.id).run();
  return scrape(env, s.url, formatsFor(s), self, client, onMiss);
}
