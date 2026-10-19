import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { DEFAULT_API } from "./client";
import { CliError, EXIT } from "./errors";

// The settings file holds only the service address and the mode; never secrets (docs/cli-plan.md, D8).
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
  const c = raw as { apiUrl?: unknown; mode?: unknown } | null;
  if (!c || typeof c !== "object" || typeof c.apiUrl !== "string") {
    throw new CliError(`The settings file ${path} has no service address (apiUrl).`, EXIT.usage, "CONFIG_INVALID", reset);
  }
  try {
    return { apiUrl: checkApiUrl(c.apiUrl), mode: c.mode === "self-hosted" ? "self-hosted" : "hosted" };
  } catch (e) {
    throw new CliError(`The settings file ${path} has an unusable service address: ${(e as Error).message}`, EXIT.usage, "CONFIG_INVALID", reset);
  }
}

export async function writeConfig(sys: System, config: Config): Promise<string> {
  const path = configPath(sys);
  await mkdir(pathApi(sys.platform).dirname(path), { recursive: true });
  const clean: Config = { apiUrl: checkApiUrl(config.apiUrl), mode: config.mode === "self-hosted" ? "self-hosted" : "hosted" };
  await writeFile(path, `${JSON.stringify(clean, null, 2)}\n`, { encoding: "utf8" });
  return path;
}

export async function resetConfig(sys: System): Promise<string> {
  const path = configPath(sys);
  await rm(path, { force: true });
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
