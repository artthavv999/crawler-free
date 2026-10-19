import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { main } from "./main";

// Questions (such as "replace this file?") are only asked when a person is at the terminal; scripts never block.
const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
const ask = async (question: string) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

// The `crawler-free` command. Everything testable lives in main(); this only connects it to the real process.
main({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  cwd: process.cwd(),
  nodeVersion: process.versions.node,
  stdout: (s) => { process.stdout.write(s); },
  stderr: (s) => { process.stderr.write(s); },
  ask: interactive ? ask : undefined,
}).then((code) => {
  process.exitCode = code;
});
