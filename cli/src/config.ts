import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { DEFAULT_API } from "./client";
import { CliError, EXIT } from "./errors";

// The settings file holds only the mode and, for your own copy, its address; never secrets (docs/cli-plan.md, D8).
// The CLI works with no settings file at all: it then uses the hosted service.
export interface Config { apiUrl: string; mode: "hosted" | "self-hosted" }
export interface System { platform: string; env: Record<string, string | undefined>; homedir: string }

const pathApi = (platform: string) => (platform === "win32" ? win32 : posix);

export function configPath({ platform, env, homedir }: System): string {
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(homedir, "AppData", "Roaming"), "crawler-free", "config.json");
  if (platform === "darwin") return posix.join(homedir, "Library", "Application Support", "crawler-free", "config.json");
  return posix.join(env.XDG_CONFIG_HOME || posix.join(homedir, ".config"), "crawler-free", "config.json");
}

// A service address the CLI will talk to: http or https, no user name or password, no query or fragment.
export function checkApiUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CliError(`"${raw}" isn't a valid web address.`, EXIT.usage, "BAD_API_URL", "Use the full address, for example https://crawler-free.crawler-free.workers.dev");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new CliError(`The service address must start with https:// (got ${u.protocol}).`, EXIT.usage, "BAD_API_URL");
  if (u.username || u.password) throw new CliError("The service address mustn't contain a user name or password.", EXIT.usage, "BAD_API_URL");
  if (u.search || u.hash) throw new CliError("The service address mustn't contain ? or # parts.", EXIT.usage, "BAD_API_URL");
  return u.href.replace(/\/+$/, "");
}

export async function readConfig(sys: System): Promise<Config | null> {
  const path = configPath(sys);
  const reset = `Delete it to go back to the hosted service: ${path}`;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw new CliError(`Couldn't read the settings file ${path}.`, EXIT.failed, "CONFIG_UNREADABLE", reset);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`The settings file ${path} isn't valid JSON.`, EXIT.usage, "CONFIG_INVALID", reset);
  }
  const invalid = (why: string) => new CliError(`The settings file ${path} ${why}.`, EXIT.usage, "CONFIG_INVALID", reset);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("isn't a settings object");
  const c = raw as { apiUrl?: unknown; mode?: unknown };
  // Hosted: the address built into this version, so a saved choice keeps working if the hosted service ever moves.
  if (c.mode === "hosted") {
    if (c.apiUrl !== undefined && c.apiUrl !== DEFAULT_API) throw invalid("says hosted but names another address");
    return { apiUrl: DEFAULT_API, mode: "hosted" };
  }
  if (c.mode !== undefined && c.mode !== "self-hosted") throw invalid(`has an unknown mode (use "hosted" or "self-hosted")`);
  if (typeof c.apiUrl !== "string") throw invalid("has no service address (apiUrl)");
  try {
    return { apiUrl: checkApiUrl(c.apiUrl), mode: "self-hosted" };
  } catch (e) {
    throw invalid(`has an unusable service address: ${(e as Error).message}`);
  }
}

// Saves the choice: { "mode": "hosted" }, or { "mode": "self-hosted", "apiUrl": ... } for your own copy.
export async function writeConfig(sys: System, config: Config): Promise<string> {
  const path = configPath(sys);
  const apiUrl = checkApiUrl(config.apiUrl);
  const clean = config.mode === "hosted" || apiUrl === DEFAULT_API ? { mode: "hosted" } : { mode: "self-hosted", apiUrl };
  await mkdir(pathApi(sys.platform).dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(clean, null, 2)}\n`, { encoding: "utf8" });
  return path;
}

// Removes the settings file, and its crawler-free folder when nothing else is in it.
export async function resetConfig(sys: System): Promise<string> {
  const path = configPath(sys);
  await rm(path, { force: true });
  await rmdir(pathApi(sys.platform).dirname(path)).catch(() => {}); // not empty or already gone: leave it
  return path;
}

// The service address to use, first match wins: --api-url, CRAWLER_FREE_API_URL, the settings file, the hosted service.
export async function resolveApiUrl(flag: string | undefined, sys: System): Promise<{ url: string; source: string }> {
  if (flag) return { url: checkApiUrl(flag), source: "--api-url" };
  const fromEnv = sys.env.CRAWLER_FREE_API_URL;
  if (fromEnv) return { url: checkApiUrl(fromEnv), source: "CRAWLER_FREE_API_URL" };
  const saved = await readConfig(sys);
  if (saved) return { url: saved.apiUrl, source: "settings file" };
  return { url: DEFAULT_API, source: "hosted service (default)" };
}
