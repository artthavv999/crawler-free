import { join, resolve, sep } from "node:path";
import { DEFAULT_API } from "./client";
import { resolveApiUrl, type System } from "./config";
import { CliError, EXIT } from "./errors";
import { hostSlug, OUTPUT_DIR, type Ask } from "./output";
import { documentsFolder, RESULTS_FOLDER } from "./places";
import { pageUrl } from "./scrape";

export interface MenuDeps {
  ask: Ask;
  stderr(s: string): void;
  stdout(s: string): void;
  cwd: string;
  sys: System;
  help: string;
  // Opens a folder in the system's file manager; absent where that isn't possible.
  openFolder?: (dir: string) => Promise<boolean>;
  // Runs an ordinary command line, exactly as if it had been typed after `crawler-free`; returns its exit code.
  run: (argv: string[]) => Promise<number>;
}

const TRIES = 3;
const gaveUp = () => new CliError("No usable answer was given, so nothing was done.", EXIT.usage, "USAGE",
  "Run `crawler-free` again, or `crawler-free --help` to see the commands.");

// A numbered choice: Enter takes the default; three answers that aren't a listed number stop the program.
async function choose(ask: Ask, title: string, options: string[], def: number): Promise<number> {
  let question = `${title}\n${options.map((o, i) => `  ${i + 1}  ${o}`).join("\n")}\nChoose 1-${options.length} [${def}]: `;
  for (let i = 0; i < TRIES; i++) {
    const answer = (await ask(question)).trim();
    if (answer === "") return def;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n;
    question = `Type a number from 1 to ${options.length} [${def}]: `;
  }
  throw gaveUp();
}

// A typed answer, checked by `check` (which returns a reason to ask again); empty answers are asked again too.
async function answer(ask: Ask, question: string, check: (s: string) => string | undefined): Promise<string> {
  let q = question;
  for (let i = 0; i < TRIES; i++) {
    const a = (await ask(q)).trim();
    const problem = a ? check(a) : "Nothing was typed.";
    if (!problem) return a;
    q = `${problem} ${question}`;
  }
  throw gaveUp();
}

// A whole number in a range; Enter takes the default.
async function count(ask: Ask, question: string, min: number, max: number, def: number): Promise<string> {
  let q = question;
  for (let i = 0; i < TRIES; i++) {
    const a = (await ask(q)).trim();
    if (a === "") return String(def);
    const n = Number(a);
    if (Number.isInteger(n) && n >= min && n <= max) return String(n);
    q = `Type a whole number from ${min} to ${max} [${def}]: `;
  }
  throw gaveUp();
}

const address = (ask: Ask, question: string) => answer(ask, question, (s) => {
  try { pageUrl(s); return undefined; } catch (e) { return (e as Error).message; }
});

// crawler-free with nothing after it, in a terminal: a short guided menu (docs/beginner-cli-plan.md, Phase B). Each
// choice becomes an ordinary command (scrape, crawl, extract, doctor, setup), so limits, checks, messages and exit
// codes are exactly those of the typed commands. Results go to <Documents>/Crawler Free unless another folder is chosen.
export async function menu(m: MenuDeps): Promise<number> {
  const { url } = await resolveApiUrl(undefined, m.sys);
  const service = url === DEFAULT_API ? "the free hosted Crawler Free service, so there's nothing to install or sign up for" : `your own Crawler Free service at ${url}`;
  m.stderr(`Crawler Free: read web pages as clean text, links or facts.\nIt uses ${service}.\n\n`);
  let code: number = EXIT.ok;
  for (;;) {
    const action = await choose(m.ask, "What would you like to do?",
      ["Read one web page (recommended)", "Read a whole website", "Look up facts on a page", "Check or change the setup", "Help and examples"], 1);
    let folder: string | undefined;
    if (action === 1) {
      const page = await address(m.ask, "Web page address (for example example.com): ");
      const kind = await choose(m.ask, "Save it as:", ["Text, as Markdown (recommended)", "A list of the page's links"], 1);
      folder = await whereToSave(m);
      code = await m.run(["scrape", page, "--format", kind === 1 ? "markdown" : "links", "--output", folder + sep]);
    } else if (action === 2) {
      const site = await address(m.ask, "Website address (for example books.toscrape.com): ");
      const limit = await count(m.ask, "How many pages at most, 1 to 100? [10]: ", 1, 100, 10);
      folder = join(await whereToSave(m), `${hostSlug(pageUrl(site))}-crawl`);
      code = await m.run(["crawl", site, "--limit", limit, "--output", folder]);
    } else if (action === 3) {
      const page = await address(m.ask, "Web page address: ");
      const fields = await answer(m.ask, "Which facts? Separate them with commas, for example: title, price\nFacts: ", () => undefined);
      folder = await whereToSave(m);
      code = await m.run(["extract", page, "--fields", fields, "--output", folder + sep]);
    } else if (action === 4) {
      code = await m.run(["doctor"]);
      const change = (await m.ask("\nChange which Crawler Free service this computer uses? [y/N] ")).trim().toLowerCase();
      if (change === "y" || change === "yes") code = await m.run(["setup"]);
    } else {
      m.stdout(m.help);
      return EXIT.ok;
    }
    // What next: open the folder (after a save), something else, or exit (the default).
    let canOpen = code === EXIT.ok && folder !== undefined && m.openFolder !== undefined;
    for (;;) {
      const options = [...(canOpen ? ["Open the folder"] : []), "Do something else", "Exit"];
      const pick = options[(await choose(m.ask, "\nWhat next?", options, options.length)) - 1];
      if (pick === "Exit") return code;
      if (pick === "Do something else") break;
      const opened = await m.openFolder!(folder!);
      m.stderr(opened ? `Opened ${folder}\n` : `Couldn't open a file manager here; the folder is ${folder}\n`);
      canOpen = false;
    }
    m.stderr("\n");
  }
}

// Where to save: <Documents>/Crawler Free (the default), ./crawler-free-output here, or a folder the person types.
async function whereToSave(m: MenuDeps): Promise<string> {
  const documents = join(await documentsFolder(m.sys), RESULTS_FOLDER);
  const here = resolve(m.cwd, OUTPUT_DIR);
  const pick = await choose(m.ask, "Where should the results go?", [`${documents} (recommended)`, `This folder: ${here}`, "Another folder"], 1);
  if (pick === 1) return documents;
  if (pick === 2) return here;
  return resolve(m.cwd, await answer(m.ask, "Folder: ", () => undefined));
}
