import type { Args } from "./args";
import type { ApiClient } from "./client";
import { CliError, EXIT } from "./errors";
import { FORMATS, mayReplace, saveFile, targetPath, type Ask, type Format } from "./output";
import { printable, type Ui } from "./ui";

interface PageData {
  markdown?: unknown;
  links?: unknown;
  warning?: unknown;
  metadata?: { title?: unknown; url?: unknown; statusCode?: unknown };
}

// What to ask the API for. "json" saves the whole answer for the page: text, links and metadata.
const REQUEST: Record<Format, string[]> = { markdown: ["markdown"], links: ["links"], json: ["markdown", "links"] };
const LABEL: Record<Format, string> = { markdown: "Markdown", links: "links", json: "JSON" };

const usage = (message: string, hint?: string) => new CliError(message, EXIT.usage, "USAGE", hint);
const badAnswer = () => new CliError("The service's answer didn't contain the page.", EXIT.failed, "BAD_RESPONSE", "Run `crawler-free doctor` to check the service address.");

// The page address as the service will get it. As on the web page, "example.com" means https://example.com.
// Only the shape is checked here: whether a page may be read (public address, robots.txt) is decided by the service.
export function pageUrl(raw: string | undefined): URL {
  if (!raw) throw usage("Give the address of the page to read.", "For example: crawler-free scrape https://example.com");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new CliError(`"${raw}" isn't a valid web address.`, EXIT.usage, "BAD_URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new CliError(`Only http:// and https:// pages can be read (got ${u.protocol}).`, EXIT.usage, "BAD_URL");
  if (u.username || u.password) throw new CliError("Addresses with a user name or password can't be read.", EXIT.usage, "BAD_URL");
  return u;
}

function render(format: Format, data: PageData): { content: string; size: string; count: number } {
  if (format === "links") {
    if (!Array.isArray(data.links) || !data.links.every((l) => typeof l === "string")) throw badAnswer();
    const links = data.links as string[];
    return { content: links.length ? `${links.join("\n")}\n` : "", size: `${links.length.toLocaleString("en-US")} link${links.length === 1 ? "" : "s"}`, count: links.length };
  }
  if (typeof data.markdown !== "string") throw badAnswer();
  const content = format === "json" ? `${JSON.stringify(data, null, 2)}\n` : data.markdown && !data.markdown.endsWith("\n") ? `${data.markdown}\n` : data.markdown;
  const chars = format === "json" ? content.length : data.markdown.length;
  return { content, size: `${chars.toLocaleString("en-US")} character${chars === 1 ? "" : "s"}`, count: chars };
}

// crawler-free scrape <url>: one page through the hosted API, saved as a file (or printed with --stdout).
// Never retried automatically: every read counts against the shared limits (docs/cli-plan.md, D9).
export async function scrape(o: { args: Args; client: ApiClient; ui: Ui; cwd: string; ask?: Ask }): Promise<number> {
  const a = o.args;
  if (a.rest.length > 1) throw usage(`scrape reads one page at a time (got ${a.rest.length} addresses).`, "`crawl` reads a whole website.");
  const url = pageUrl(a.rest[0]);
  const format = (a.format ?? "markdown") as Format;
  if (!FORMATS.includes(format)) throw usage(`Unknown format "${a.format}". Choose markdown, links or json.`);
  if (a.stdout && a.json) throw usage("--stdout and --json both print to stdout; use one of them.");
  if (a.stdout && a.output !== undefined) throw usage("--stdout and --output can't be used together.");

  const ask = o.ui.mode.json ? undefined : o.ask; // --json never asks questions
  let path = "";
  let force = a.force;
  if (!a.stdout) {
    path = await targetPath(a.output, o.cwd, url, format);
    force = await mayReplace(path, { force, ask });
  }

  o.ui.progress(`Reading ${url.href} ...`);
  const { body, headers } = await o.client.postWithHeaders<{ data?: PageData }>("/v2/scrape", { url: url.href, formats: REQUEST[format] });
  const data = body?.data;
  if (!data || typeof data !== "object") throw badAnswer();
  const { content, size, count } = render(format, data);
  const cached = headers.get("x-cache") === "HIT";
  if (typeof data.warning === "string") o.ui.progress(`Note: ${data.warning}`);
  if (count === 0 && format !== "json") o.ui.progress(format === "links" ? "Note: the page has no links." : "Note: the page had no readable text.");

  if (a.stdout) {
    o.ui.out(content);
    o.ui.progress(`Done: ${size}${cached ? " (from the service's 1-hour cache)" : ""}.`);
    return EXIT.ok;
  }

  await saveFile(path, content, { force, ask });
  const title = typeof data.metadata?.title === "string" ? data.metadata.title : "";
  if (o.ui.mode.json) {
    o.ui.json({
      ok: true, command: "scrape", url: url.href, finalUrl: typeof data.metadata?.url === "string" ? data.metadata.url : null,
      format, savedTo: path, [format === "links" ? "links" : "characters"]: count, cached, title, warning: data.warning ?? null,
    });
  } else if (o.ui.mode.quiet) {
    o.ui.out(`${path}\n`);
  } else {
    o.ui.out(`Saved ${LABEL[format]} (${size}${title ? ` from "${printable(title, 80)}"` : ""}) to ${path}\n${cached ? "The service answered from its cache (pages are cached for 1 hour).\n" : ""}`);
  }
  return EXIT.ok;
}
