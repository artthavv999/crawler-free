import { execFile } from "node:child_process";

// The one place the CLI starts another program (docs/beginner-cli-plan.md, E5): the system's own file manager, given
// one folder the CLI itself saved into, as a single argument and with no shell. Only the guided menu calls it, when a
// person picks "Open the folder". Resolves to whether the program started.
const FILE_MANAGER: Record<string, string> = { win32: "explorer.exe", darwin: "open" };

export function openFolder(dir: string, platform: string): Promise<boolean> {
  return new Promise((resolve) => {
    // explorer.exe exits with code 1 even when it worked, so only whether it started counts.
    const child = execFile(FILE_MANAGER[platform] ?? "xdg-open", [dir], () => {});
    child.once("spawn", () => { child.unref(); resolve(true); });
    child.once("error", () => resolve(false));
  });
}
