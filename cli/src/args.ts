import { parseArgs } from "node:util";
import { CliError, EXIT } from "./errors";

export interface Args {
  command?: string;
  rest: string[];
  help: boolean;
  version: boolean;
  json: boolean;
  quiet: boolean;
  apiUrl?: string;
  timeoutMs: number;
  // scrape
  format?: string;
  output?: string;
  stdout: boolean;
  force: boolean;
  // crawl
  limit?: string;
  depth?: string;
  maxWait?: string;
  // extract
  fields?: string[];
  // setup
  hosted: boolean;
  reset: boolean;
}

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  "api-url": { type: "string" },
  timeout: { type: "string" },
  format: { type: "string", short: "f" },
  output: { type: "string", short: "o" },
  stdout: { type: "boolean" },
  force: { type: "boolean" },
  limit: { type: "string" },
  depth: { type: "string" },
  "max-wait": { type: "string" },
  fields: { type: "string", multiple: true },
  hosted: { type: "boolean" },
  reset: { type: "boolean" },
} as const;

// Options that only make sense for some commands; anything else rejects them instead of silently ignoring them.
export const COMMAND_OPTIONS: Record<string, (keyof Args)[]> = {
  scrape: ["format", "output", "stdout", "force"],
  crawl: ["limit", "depth", "maxWait", "output", "force"],
  extract: ["fields", "output", "stdout", "force"],
  setup: ["hosted", "reset", "force"],
};
const FLAG_NAMES: Partial<Record<keyof Args, string>> = {
  format: "--format", output: "--output", stdout: "--stdout", force: "--force", limit: "--limit", depth: "--depth", maxWait: "--max-wait",
  fields: "--fields", hosted: "--hosted", reset: "--reset",
};

export function parse(argv: string[]): Args {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    const first = (e as Error).message.split(". To specify")[0].replace(/\.$/, "");
    throw new CliError(`${first}.`, EXIT.usage, "USAGE", "Run `crawler-free --help` to see the commands and options.");
  }
  const v = parsed.values;
  let timeoutMs = 60_000;
  if (v.timeout !== undefined) {
    const seconds = Number(v.timeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
      throw new CliError("--timeout must be a whole number of seconds from 1 to 3600.", EXIT.usage, "USAGE");
    }
    timeoutMs = seconds * 1000;
  }
  const [command, ...rest] = parsed.positionals;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  return {
    command,
    rest,
    help: v.help === true,
    version: v.version === true,
    json: v.json === true,
    quiet: v.quiet === true,
    apiUrl: str("api-url"),
    timeoutMs,
    format: str("format"),
    output: str("output"),
    stdout: v.stdout === true,
    force: v.force === true,
    limit: str("limit"),
    depth: str("depth"),
    maxWait: str("max-wait"),
    fields: Array.isArray(v.fields) ? v.fields : undefined,
    hosted: v.hosted === true,
    reset: v.reset === true,
  };
}

// Rejects command-specific options given to a command that doesn't use them.
export function checkOptionsFor(command: string, a: Args): void {
  const allowed = new Set(COMMAND_OPTIONS[command] ?? []);
  for (const key of Object.keys(FLAG_NAMES) as (keyof Args)[]) {
    const set = a[key] !== undefined && a[key] !== false;
    if (set && !allowed.has(key)) {
      throw new CliError(`${FLAG_NAMES[key]} doesn't work with "${command}".`, EXIT.usage, "USAGE", "Run `crawler-free --help` to see which options each command takes.");
    }
  }
}
