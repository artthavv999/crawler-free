import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { ApiClient, type Fetch } from "./client";
import { configPath, readConfig, resolveApiUrl, type System } from "./config";
import { CliError, EXIT, type ExitCode } from "./errors";
import type { Ui } from "./ui";

export interface Check { name: string; ok: boolean; detail: string; hint?: string; exitCode?: ExitCode }

export const MIN_NODE = 22;
// A job ID that never exists: the API answers 404 NOT_FOUND as JSON. This proves the API is answering without starting
// any work; it costs one of the 60 status checks a minute. (There is no health endpoint; docs/cli-plan.md D6.)
const NO_SUCH_JOB = "00000000-0000-4000-8000-000000000000";

const asCli = (e: unknown) => (e instanceof CliError ? e : new CliError(String((e as Error)?.message ?? e), EXIT.failed, "INTERNAL"));
const failed = (name: string, e: unknown): Check => { const c = asCli(e); return { name, ok: false, detail: c.message, hint: c.hint, exitCode: c.exitCode }; };

export interface DoctorOptions {
  sys: System;
  cwd: string;
  nodeVersion: string;
  apiUrlFlag?: string;
  timeoutMs: number;
  fetch?: Fetch;
  ui: Ui;
  version: string;
}

// Checks Node.js, the settings file, the connection to the service, that the API answers, and the output folder.
// Never prints secrets (the CLI has none) or stack traces.
export async function doctor(o: DoctorOptions): Promise<number> {
  const checks: Check[] = [];

  const major = Number(o.nodeVersion.split(".")[0]);
  checks.push(major >= MIN_NODE
    ? { name: "node", ok: true, detail: `Node.js ${o.nodeVersion} (${MIN_NODE} or newer needed)` }
    : { name: "node", ok: false, detail: `Node.js ${o.nodeVersion} is too old; ${MIN_NODE} or newer is needed.`, hint: "Install the current LTS version from https://nodejs.org", exitCode: EXIT.failed });

  try {
    const saved = await readConfig(o.sys);
    checks.push({ name: "settings", ok: true, detail: saved ? `Settings file ${configPath(o.sys)} (${saved.mode})` : "No settings saved; the hosted service is used" });
  } catch (e) {
    checks.push(failed("settings", e));
  }

  let apiUrl: string | undefined;
  let source = "";
  try {
    ({ url: apiUrl, source } = await resolveApiUrl(o.apiUrlFlag, o.sys));
  } catch (e) {
    if (!checks.some((c) => c.name === "settings" && !c.ok)) checks.push(failed("service address", e));
  }

  if (apiUrl) {
    const client = new ApiClient({ baseUrl: apiUrl, timeoutMs: o.timeoutMs, fetch: o.fetch });
    let reachable = false;
    try {
      const started = Date.now();
      const res = await client.request("/");
      await res.body?.cancel();
      reachable = res.status < 500;
      checks.push(reachable
        ? { name: "connection", ok: true, detail: `Reached ${apiUrl} (HTTP ${res.status}, ${Date.now() - started} ms; address from ${source})` }
        : { name: "connection", ok: false, detail: `${apiUrl} answered HTTP ${res.status}.`, hint: "The service may be having trouble; try again in a few minutes.", exitCode: EXIT.failed });
    } catch (e) {
      checks.push(failed("connection", e));
    }
    if (reachable) checks.push(await apiCheck(client));
  }

  checks.push(await outputCheck(o.cwd));

  const bad = checks.filter((c) => !c.ok);
  if (o.ui.mode.json) {
    o.ui.json({ ok: bad.length === 0, version: o.version, apiUrl: apiUrl ?? null, apiUrlSource: source || null, checks });
  } else {
    o.ui.out(`Crawler Free doctor (CLI ${o.version})\n`);
    for (const c of checks) o.ui.out(`  ${c.ok ? "ok  " : "FAIL"}  ${c.detail}\n${c.hint ? `        ${c.hint}\n` : ""}`);
    o.ui.out(bad.length ? `${bad.length} check${bad.length > 1 ? "s" : ""} failed.\n` : "All checks passed.\n");
  }
  return bad.length ? (bad[0].exitCode ?? EXIT.failed) : EXIT.ok;
}

async function apiCheck(client: ApiClient): Promise<Check> {
  try {
    await client.get(`/v2/crawl/${NO_SUCH_JOB}`);
    return { name: "api", ok: true, detail: "The API answered" };
  } catch (e) {
    const err = asCli(e);
    if (err.code === "NOT_FOUND") return { name: "api", ok: true, detail: "The API answered (a test request for a job that doesn't exist got NOT_FOUND, as expected)" };
    if (err.code === "RATE_LIMITED") return { name: "api", ok: true, detail: "The API answered (status checks are rate limited for your connection right now)" };
    if (err.code === "DISABLED") return { name: "api", ok: false, detail: err.message, hint: "The service is switched off for maintenance; try again later.", exitCode: EXIT.failed };
    if (err.code === "BAD_RESPONSE" || err.code.startsWith("HTTP_")) {
      return { name: "api", ok: false, detail: "This address doesn't answer like a Crawler Free service.", hint: "Check the address (--api-url, CRAWLER_FREE_API_URL or the settings file).", exitCode: EXIT.failed };
    }
    return { name: "api", ok: false, detail: err.message, hint: err.hint, exitCode: err.exitCode };
  }
}

async function outputCheck(cwd: string): Promise<Check> {
  const dir = resolve(cwd, "crawler-free-output");
  try {
    await access(dir, constants.W_OK);
    return { name: "output", ok: true, detail: `Results folder ${dir} is writable` };
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      return { name: "output", ok: false, detail: `Results folder ${dir} isn't writable.`, hint: "Run Crawler Free from a folder you can save files in.", exitCode: EXIT.output };
    }
  }
  try {
    await access(cwd, constants.W_OK);
    return { name: "output", ok: true, detail: `Results will be saved in ${dir} (created when needed)` };
  } catch {
    return { name: "output", ok: false, detail: `This folder (${cwd}) isn't writable, so results can't be saved here.`, hint: "Run Crawler Free from a folder you can save files in.", exitCode: EXIT.output };
  }
}
