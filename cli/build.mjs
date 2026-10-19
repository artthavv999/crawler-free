// Builds the `crawler-free` command into one file, cli/dist/crawler-free.mjs (run `npm run build:cli`).
// No runtime dependencies: everything the CLI uses ships with Node.js 22+. dist/ is not committed.
import { build } from "esbuild";
import { chmod, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(await readFile(here("./package.json"), "utf8"));
const source = await readFile(here("./src/version.ts"), "utf8");
if (!source.includes(`"${pkg.version}"`)) throw new Error(`cli/src/version.ts doesn't match cli/package.json version ${pkg.version}`);

const outfile = here("./dist/crawler-free.mjs");
await build({
  entryPoints: [here("./src/bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
});
await chmod(outfile, 0o755); // executable on macOS and Linux; Windows uses npm's .cmd shim
console.log(`built ${outfile}`);
