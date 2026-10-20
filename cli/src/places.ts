import { readFile, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

// The guided menu saves into "<Documents>/Crawler Free" by default (docs/beginner-cli-plan.md, E4); explicit commands
// keep ./crawler-free-output/.
export const RESULTS_FOLDER = "Crawler Free";

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);

// The folder people know as Documents: on Windows, OneDrive's when OneDrive keeps it, otherwise the usual one; on
// Linux, XDG_DOCUMENTS_DIR from user-dirs.dirs; otherwise ~/Documents. The home folder when none of them exists.
export async function documentsFolder(sys: { platform: string; env: Record<string, string | undefined>; homedir: string }): Promise<string> {
  const p = sys.platform === "win32" ? win32 : posix;
  const candidates: string[] = [];
  if (sys.platform === "win32" && sys.env.OneDrive) candidates.push(p.join(sys.env.OneDrive, "Documents"));
  if (sys.platform === "linux") {
    const dirs = await readFile(p.join(sys.env.XDG_CONFIG_HOME || p.join(sys.homedir, ".config"), "user-dirs.dirs"), "utf8").catch(() => "");
    const set = dirs.match(/^XDG_DOCUMENTS_DIR="([^"]*)"/m)?.[1];
    if (set) candidates.push(set.replace(/^\$HOME(?=\/|$)/, sys.homedir));
  }
  candidates.push(p.join(sys.homedir, "Documents"));
  for (const c of candidates) if (p.isAbsolute(c) && (await isDir(c))) return c;
  return sys.homedir;
}
