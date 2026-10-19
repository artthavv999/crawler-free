import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { CliError, EXIT } from "./errors";

export type Format = "markdown" | "links" | "json";
export const FORMATS: Format[] = ["markdown", "links", "json"];
// What a saved file holds: a scrape format, or facts from extract (".facts.json", so it never takes the name of a
// scrape --format json file for the same page).
export type Kind = Format | "facts";
export const EXTENSION: Record<Kind, string> = { markdown: "md", links: "txt", json: "json", facts: "facts.json" };
export const OUTPUT_DIR = "crawler-free-output";

export type Ask = (question: string) => Promise<string>;

// FNV-1a: a short, stable tag for a query string, so ?page=1 and ?page=2 don't share a file name.
function tag(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// A file name built only from the address the user asked for (never from page content): host, then path segments,
// with anything but letters, digits, dot, dash and underscore replaced. It can't contain a path separator or "..",
// it never ends in a dot or space (Windows), and it always starts with the host, so it can't be a reserved
// Windows device name such as CON or NUL.
export function fileNameFor(url: URL, format: Kind): string {
  // (Existing "--" is kept: international domains are written "xn--…".)
  const clean = (s: string) => s.toLowerCase().replace(/(%[0-9a-f]{2})+/gi, "-").replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  const host = clean(url.port ? `${url.hostname}-${url.port}` : url.hostname) || "page";
  const parts = [host, ...url.pathname.split("/").map(clean).filter(Boolean)];
  let base = parts.join("_");
  if (url.search) base += `_${tag(url.search)}`;
  base = base.slice(0, 120).replace(/[-._]+$/, "");
  return `${base}.${EXTENSION[format]}`;
}

// Where to save: --output as a file path, or as a folder when it ends with a slash or is an existing folder;
// otherwise ./crawler-free-output/<name>. The user's own --output is trusted; generated names stay inside their folder.
export async function targetPath(output: string | undefined, cwd: string, url: URL, format: Kind): Promise<string> {
  const name = fileNameFor(url, format);
  if (output === undefined) return inside(resolve(cwd, OUTPUT_DIR), name);
  if (output.trim() === "") throw new CliError("--output needs a file or folder name.", EXIT.usage, "USAGE");
  const full = resolve(cwd, output);
  if (/[\\/]$/.test(output)) return inside(full, name);
  const existing = await stat(full).catch(() => null);
  return existing?.isDirectory() ? inside(full, name) : full;
}

export function inside(dir: string, name: string): string {
  const path = resolve(dir, name);
  if (!path.startsWith(dir.endsWith(sep) ? dir : dir + sep)) throw new CliError(`Refusing to save outside ${dir}.`, EXIT.output, "BAD_PATH");
  return path;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

// Decides before any page is read whether an existing file may be replaced, so a refusal costs no quota.
// Returns true when the save should replace the file (--force, or a person said yes).
export async function mayReplace(path: string, o: { force: boolean; ask?: Ask }): Promise<boolean> {
  if (o.force || !(await exists(path))) return o.force;
  if (!o.ask) throw new CliError(`${path} already exists.`, EXIT.output, "FILE_EXISTS", "Use --force to replace it, or --output to choose another name.");
  const answer = (await o.ask(`${path} already exists. Replace it? [y/N] `)).trim().toLowerCase();
  if (answer === "y" || answer === "yes") return true;
  throw new CliError(`Kept the existing file ${path}; nothing was read or saved.`, EXIT.output, "FILE_EXISTS", "Use --output to choose another name, or --force to replace it.");
}

// Saves without ever replacing a file silently: exclusive create first; if the file exists, ask in an interactive
// terminal, otherwise stop with exit 6 unless --force was given. (Also catches a file that appeared during the read.)
export async function saveFile(path: string, content: string, o: { force: boolean; ask?: Ask }): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (e) {
    throw cantSave(path, e); // e.g. a file where a folder is needed
  }
  try {
    await writeFile(path, content, { encoding: "utf8", flag: o.force ? "w" : "wx" });
    return;
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw cantSave(path, e);
  }
  if (o.ask) {
    const answer = (await o.ask(`${path} already exists. Replace it? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new CliError(`Kept the existing file ${path}; nothing was saved.`, EXIT.output, "FILE_EXISTS", "Use --output to choose another name, or --force to replace it.");
    }
    try {
      await writeFile(path, content, { encoding: "utf8", flag: "w" });
      return;
    } catch (e) {
      throw cantSave(path, e);
    }
  }
  throw new CliError(`${path} already exists.`, EXIT.output, "FILE_EXISTS", "Use --force to replace it, or --output to choose another name.");
}

export function cantSave(path: string, e: unknown): CliError {
  const code = (e as { code?: string }).code ?? "error";
  return new CliError(`Couldn't save ${path} (${code}).`, EXIT.output, "CANT_SAVE", "Check the folder exists and you can write to it, or choose another place with --output.");
}

// The site part of a file or folder name: host (and port), cleaned like fileNameFor.
export function hostSlug(url: URL): string {
  return fileNameFor(new URL(url.origin), "markdown").replace(/\.md$/, "");
}

// Before a crawl starts: a results folder that already has files in it is only used if --force was given or a person
// said yes. Returns true when files with the same names may be replaced. Nothing is ever deleted.
export async function mayUseFolder(dir: string, o: { force: boolean; ask?: Ask }): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") return o.force;
    if (code === "ENOTDIR") throw new CliError(`${dir} is a file, not a folder.`, EXIT.output, "BAD_PATH", "Choose a folder with --output.");
    throw cantSave(dir, e);
  }
  if (!entries.length || o.force) return o.force;
  if (!o.ask) {
    throw new CliError(`${dir} already has files in it.`, EXIT.output, "FOLDER_NOT_EMPTY", "Use --force to replace files with the same names, or --output to choose another folder.");
  }
  const answer = (await o.ask(`${dir} already has files in it. Replace files with the same names? [y/N] `)).trim().toLowerCase();
  if (answer === "y" || answer === "yes") return true;
  throw new CliError(`Kept ${dir} as it is; the crawl wasn't started.`, EXIT.output, "FOLDER_NOT_EMPTY", "Use --output to choose another folder, or --force to replace files with the same names.");
}
