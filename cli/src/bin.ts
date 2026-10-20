import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { isSea } from "node:sea";
import { main } from "./main";

// Questions (such as "replace this file?") are only asked when a person is at the terminal; scripts never block.
// Ctrl+C at a question stops the program (exit 130) before anything is saved; end of input (Ctrl+D, or Ctrl+Z then
// Enter on Windows) counts as an empty answer, which is always the safe default.
const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
const ask = (question: string) => new Promise<string>((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let answered = false;
  rl.on("SIGINT", () => {
    process.stderr.write("\nStopped; nothing was changed.\n");
    process.exit(130);
  });
  rl.on("close", () => { if (!answered) resolve(""); });
  rl.question(question).then(
    (answer) => { answered = true; rl.close(); resolve(answer); },
    () => resolve(""),
  );
});

// The `crawler-free` command. Everything testable lives in main(); this only connects it to the real process.
main({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  cwd: process.cwd(),
  nodeVersion: process.versions.node,
  standalone: isSea(),
  stdout: (s) => { process.stdout.write(s); },
  stderr: (s) => { process.stderr.write(s); },
  ask: interactive ? ask : undefined,
}).then((code) => {
  process.exitCode = code;
});
