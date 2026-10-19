import type { Args } from "./args";
import { DEFAULT_API, type ApiClient } from "./client";
import { CliError, EXIT } from "./errors";
import { mayReplace, saveFile, targetPath, type Ask } from "./output";
import { pageUrl } from "./scrape";
import { printable, type Ui } from "./ui";

export const MAX_FIELDS = 20;
export const MAX_FIELD_LENGTH = 60;

interface FactsData { json?: unknown; warning?: unknown; metadata?: { title?: unknown; url?: unknown } }

const usage = (message: string, hint?: string) => new CliError(message, EXIT.usage, "USAGE", hint);
const EXAMPLE = "For example: crawler-free extract https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html --fields title,price";

// Field names the way the service takes them for saved setups (src/setups.ts): trimmed, spaces become "_", repeats
// dropped, 1 to 20 names of up to 60 characters each. --fields can be given more than once.
export function fieldNames(raw: string[] | undefined): string[] {
  const names = [...new Set((raw ?? []).flatMap((r) => r.split(",")).map((f) => f.trim().replace(/\s+/g, "_")).filter(Boolean))];
  if (!names.length) throw usage("Say which facts to look up with --fields, separated by commas.", EXAMPLE);
  if (names.length > MAX_FIELDS) throw usage(`--fields takes up to ${MAX_FIELDS} names (got ${names.length}).`);
  const long = names.find((f) => f.length > MAX_FIELD_LENGTH);
  if (long) throw usage(`Each field name can be up to ${MAX_FIELD_LENGTH} characters ("${printable(long, 24)}" has ${long.length}).`);
  return names;
}

// The schema the service builds for a saved setup's facts, so the same page and fields share its 1-hour cache.
const schemaFor = (fields: string[]) => ({ type: "object", properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])) });

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// crawler-free extract <url> --fields a,b: facts from one page, read by the service's AI model, saved as JSON.
// Never retried automatically: a fresh look-up uses the shared AI budget (docs/cli-plan.md, D9).
export async function extract(o: { args: Args; client: ApiClient; ui: Ui; cwd: string; ask?: Ask }): Promise<number> {
  const a = o.args;
  if (!a.rest.length) throw usage("Give the address of the page to look up.", EXAMPLE);
  if (a.rest.length > 1) throw usage(`extract reads one page at a time (got ${a.rest.length} addresses).`);
  const url = pageUrl(a.rest[0]);
  const fields = fieldNames(a.fields);
  if (a.stdout && a.json) throw usage("--stdout and --json both print to stdout; use one of them.");
  if (a.stdout && a.output !== undefined) throw usage("--stdout and --output can't be used together.");

  const ask = o.ui.mode.json ? undefined : o.ask; // --json never asks questions
  let path = "";
  let force = a.force;
  if (!a.stdout) {
    path = await targetPath(a.output, o.cwd, url, "facts");
    force = await mayReplace(path, { force, ask }); // before the look-up, so a refusal uses no quota
  }

  o.ui.progress(`Looking up ${fields.join(", ")} on ${url.href} ...`);
  if (o.client.baseUrl === DEFAULT_API) {
    o.ui.progress("Facts are read by a small AI model whose free daily budget everyone shares: 20 fresh look-ups a day per connection. "
      + "The same page and fields again within an hour come from the cache and don't count.");
  }
  const { body, headers } = await o.client.postWithHeaders<{ data?: FactsData }>("/v2/scrape", {
    url: url.href,
    formats: [{ type: "json", schema: schemaFor(fields) }],
  });
  const data = body?.data;
  const facts = data?.json;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    throw new CliError("The service's answer didn't contain the facts.", EXIT.failed, "BAD_RESPONSE", "Run `crawler-free doctor` to check the service address.");
  }
  const values = facts as Record<string, unknown>;
  const empty = fields.filter((f) => isEmpty(values[f]));
  const cached = headers.get("x-cache") === "HIT";
  const content = `${JSON.stringify(values, null, 2)}\n`;
  if (typeof data.warning === "string") o.ui.progress(`Note: ${data.warning}`);

  if (a.stdout) {
    o.ui.out(content);
    o.ui.progress(`Done: ${fields.length - empty.length} of ${fields.length} facts found${cached ? " (from the service's 1-hour cache)" : ""}.`);
    return EXIT.ok;
  }

  await saveFile(path, content, { force, ask });
  const title = typeof data.metadata?.title === "string" ? data.metadata.title : "";
  if (o.ui.mode.json) {
    o.ui.json({
      ok: true, command: "extract", url: url.href, finalUrl: typeof data.metadata?.url === "string" ? data.metadata.url : null,
      fields, savedTo: path, facts: values, empty, cached, title, warning: data.warning ?? null,
    });
  } else if (o.ui.mode.quiet) {
    o.ui.out(`${path}\n`);
  } else {
    let text = `Saved ${fields.length} fact${fields.length === 1 ? "" : "s"}${title ? ` from "${printable(title, 80)}"` : ""} to ${path}\n`;
    for (const f of fields) {
      const v = values[f];
      text += `  ${f}: ${isEmpty(v) ? "(empty)" : printable(typeof v === "string" ? v : JSON.stringify(v))}\n`;
    }
    if (empty.length) text += `Not found on the page, or the model couldn't tell: ${empty.join(", ")}\n`;
    if (cached) text += "The service answered from its cache, so no look-up was used.\n";
    text += "Facts come from a small AI model and can be wrong: check anything important against the page.\n";
    o.ui.out(text);
  }
  return EXIT.ok;
}
