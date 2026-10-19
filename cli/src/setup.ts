import { stat } from "node:fs/promises";
import type { Args } from "./args";
import { ApiClient, DEFAULT_API, type Fetch } from "./client";
import { checkApiUrl, configPath, readConfig, resetConfig, writeConfig, type Config, type System } from "./config";
import { serviceChecks } from "./doctor";
import { CliError, EXIT } from "./errors";
import type { Ask } from "./output";
import type { Ui } from "./ui";

const HOSTED: Config = { apiUrl: DEFAULT_API, mode: "hosted" };
const SELF_HOSTING = "https://github.com/artthavv999/crawler-free#self-hosting-cloudflare-free-0";
const TRIES = 3;

export const HOSTED_LIMITS = `The hosted service is free and shared by everyone, so each connection has limits:
  - 20 page reads a minute and 1,000 a day
  - 5 whole-website reads a day, of up to 100 pages each
  - 20 fact look-ups a day (a small AI model; the same page and fields within an hour don't count again)
Some budgets are shared by everyone and reset at 00:00 UTC. When a limit is reached, crawler-free says when you can
try again and stops with exit code 4.
`;

const usage = (message: string, hint?: string) => new CliError(message, EXIT.usage, "USAGE", hint);
const describe = (c: Config) => (c.mode === "hosted" ? `the free hosted service (${c.apiUrl})` : `your own service at ${c.apiUrl}`);
const asConfig = (apiUrl: string): Config => (apiUrl === DEFAULT_API ? HOSTED : { apiUrl, mode: "self-hosted" });
const exists = (path: string) => stat(path).then(() => true, () => false);

function cantWrite(path: string, e: unknown): CliError {
  const code = (e as { code?: string }).code ?? "error";
  return new CliError(`Couldn't change the settings file ${path} (${code}).`, EXIT.output, "CONFIG_UNWRITABLE", "Check that you can write to that folder.");
}

// crawler-free setup: choose the service once (docs/cli-plan.md, D8). The hosted service needs no account, key or
// Cloudflare setup. At a terminal it asks; --hosted, --api-url and --reset answer without questions, and a script
// with none of them gets the hosted service. The connection is tested before anything is saved.
export async function setup(o: { args: Args; sys: System; ui: Ui; ask?: Ask; fetch?: Fetch }): Promise<number> {
  const a = o.args;
  if (a.rest.length) throw usage(`setup doesn't take an address as a word (got "${a.rest[0]}").`, "To use your own service: crawler-free setup --api-url <address>");
  if (a.reset) {
    if (a.hosted || a.apiUrl !== undefined || a.force) throw usage("--reset can't be combined with other setup options.");
    return reset(o);
  }
  if (a.hosted && a.apiUrl !== undefined) throw usage("Choose one: --hosted or --api-url.");
  const ask = o.ui.mode.json ? undefined : o.ask; // --json never asks questions
  const path = configPath(o.sys);

  let current: Config | null = null;
  try {
    current = await readConfig(o.sys);
  } catch {
    o.ui.progress(`The settings file ${path} can't be used; this setup will replace it.`);
  }

  let choice: Config;
  if (a.hosted) choice = HOSTED;
  else if (a.apiUrl !== undefined) choice = asConfig(checkApiUrl(a.apiUrl));
  else if (ask) choice = await guided(ask, current);
  else {
    choice = HOSTED;
    o.ui.progress("Using the free hosted service (the default). For your own copy instead: crawler-free setup --api-url <address>");
  }

  o.ui.progress(`Checking ${choice.apiUrl} ...`);
  const checks = await serviceChecks(new ApiClient({ baseUrl: choice.apiUrl, timeoutMs: a.timeoutMs, fetch: o.fetch }));
  for (const c of checks) o.ui.progress(`  ${c.ok ? "ok  " : "FAIL"}  ${c.detail}${c.hint ? `\n        ${c.hint}` : ""}`);
  const bad = checks.find((c) => !c.ok);
  if (bad && !a.force) {
    const anyway = ask ? (await ask("The check failed. Save this setting anyway? [y/N] ")).trim().toLowerCase() : "";
    if (anyway !== "y" && anyway !== "yes") {
      throw new CliError(`Nothing was saved: ${bad.detail}`, bad.exitCode ?? EXIT.failed, "SETUP_CHECK_FAILED",
        `${bad.hint ? `${bad.hint} ` : ""}Check the address and try again, or add --force to save it anyway.`);
    }
  }

  try {
    await writeConfig(o.sys, choice);
  } catch (e) {
    throw e instanceof CliError ? e : cantWrite(path, e);
  }
  const fromEnv = o.sys.env.CRAWLER_FREE_API_URL;
  const envNote = fromEnv ? `Note: CRAWLER_FREE_API_URL is set (${fromEnv}), so it's used instead of this setting until you remove it.\n` : "";

  if (o.ui.mode.json) {
    o.ui.json({ ok: true, command: "setup", mode: choice.mode, apiUrl: choice.apiUrl, settingsFile: path, checked: !bad, checks, overriddenBy: fromEnv ? "CRAWLER_FREE_API_URL" : null });
  } else if (o.ui.mode.quiet) {
    o.ui.out(`${path}\n`);
  } else {
    o.ui.out(`Saved. crawler-free will use ${describe(choice)}.\n`
      + `${bad ? "The connection check failed, so it may not work yet.\n" : ""}`
      + `Settings file: ${path}\n`
      + "To change it, run `crawler-free setup` again. To remove the file and go back to the hosted service, run `crawler-free setup --reset`.\n"
      + envNote
      + `\n${choice.mode === "hosted" ? HOSTED_LIMITS : "Its limits are the ones set in your copy's code and Cloudflare account.\n"}`
      + "\nTry it: crawler-free scrape https://example.com\n");
  }
  return EXIT.ok;
}

// The questions, at a terminal only. Pressing Enter takes the default, the hosted service.
async function guided(ask: Ask, current: Config | null): Promise<Config> {
  const now = current ? describe(current) : "the free hosted service (the default; nothing saved yet)";
  let question = `Crawler Free setup\nRight now crawler-free uses ${now}.\n\n`
    + "Which service should it use?\n"
    + "  1  The free hosted service (recommended): nothing to install, no account or key\n"
    + "  2  Your own copy on your Cloudflare account (self-hosted, for advanced users)\n"
    + "Type 1 or 2 [1]: ";
  for (let i = 0; i < TRIES; i++) {
    const answer = (await ask(question)).trim();
    if (answer === "" || answer === "1") return HOSTED;
    if (answer === "2") return ownService(ask);
    question = "Type 1 or 2 [1]: ";
  }
  throw usage("No choice was made, so nothing was saved.", "Run `crawler-free setup` again, or use --hosted or --api-url <address>.");
}

async function ownService(ask: Ask): Promise<Config> {
  let question = `\nThis needs your own copy of Crawler Free deployed first. The steps are in the README:\n  ${SELF_HOSTING}\n\n`
    + "Your service's address (for example https://crawler-free.<your-subdomain>.workers.dev): ";
  for (let i = 0; i < TRIES; i++) {
    const answer = (await ask(question)).trim();
    if (answer) {
      try {
        return asConfig(checkApiUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(answer) ? answer : `https://${answer}`));
      } catch (e) {
        question = `${(e as Error).message} Type the address again: `;
        continue;
      }
    }
    question = "Type your service's address, starting with https:// : ";
  }
  throw usage("No usable address was given, so nothing was saved.", "Run `crawler-free setup` again, or use --api-url <address>.");
}

async function reset(o: { sys: System; ui: Ui }): Promise<number> {
  const path = configPath(o.sys);
  const existed = await exists(path);
  try {
    await resetConfig(o.sys);
  } catch (e) {
    throw cantWrite(path, e);
  }
  const fromEnv = o.sys.env.CRAWLER_FREE_API_URL;
  if (o.ui.mode.json) {
    o.ui.json({ ok: true, command: "setup", reset: true, removed: existed, settingsFile: path, overriddenBy: fromEnv ? "CRAWLER_FREE_API_URL" : null });
  } else if (o.ui.mode.quiet) {
    o.ui.out(`${path}\n`);
  } else {
    o.ui.out(`${existed ? `Removed the settings file ${path}.` : `There was no settings file (${path}).`} crawler-free uses the free hosted service.\n`
      + (fromEnv ? `Note: CRAWLER_FREE_API_URL is set (${fromEnv}), so it's used instead until you remove it.\n` : ""));
  }
  return EXIT.ok;
}
