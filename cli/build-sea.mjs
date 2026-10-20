// Builds a standalone `crawler-free` for this computer's system, which runs without Node.js installed
// (`npm run build:cli-binary`). It uses Node's own single executable application support (`node --build-sea`, Node
// 25.5 or newer): the CLI, bundled as CommonJS, is placed inside a copy of the Node binary that runs this script, so no
// third-party code is added. Output in cli/dist/sea/ (not committed): the program, LICENSE and NODE-LICENSE.txt
// (Node.js and the libraries inside it, which every copy must carry).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  throw new Error(`Standalone builds need Node.js 25.5 or newer (\`node --build-sea\`); this is ${process.versions.node}.`);
}
const pkg = JSON.parse(await readFile(here("./package.json"), "utf8"));
const source = await readFile(here("./src/version.ts"), "utf8");
if (!source.includes(`"${pkg.version}"`)) throw new Error(`cli/src/version.ts doesn't match cli/package.json version ${pkg.version}`);

const out = here("./dist/sea/");
const program = join(out, process.platform === "win32" ? "crawler-free.exe" : "crawler-free");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The same code as the npm package, as CommonJS, the format a single executable starts from.
await build({
  entryPoints: [here("./src/bin.ts")],
  outfile: join(out, "crawler-free.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
});
await writeFile(join(out, "sea-config.json"), JSON.stringify({
  main: join(out, "crawler-free.cjs"),
  output: program,
  disableExperimentalSEAWarning: true,
  useCodeCache: false, // keeps the program the same whichever machine builds it
  useSnapshot: false,
}, null, 2));
execFileSync(process.execPath, ["--build-sea", join(out, "sea-config.json")], { stdio: "inherit" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", "--force", program], { stdio: "inherit" }); // macOS runs only signed programs; this is an ad-hoc signature

// Licences: Crawler Free's, and Node's. Node's zip and tar downloads (and so the CI runners) keep LICENSE beside
// node.exe on Windows and one folder up on macOS and Linux; the Windows installer leaves it out, so then the licence
// of this exact Node version is taken from Node's own repository.
await copyFile(here("./LICENSE"), join(out, "LICENSE"));
await writeFile(join(out, "NODE-LICENSE.txt"), await nodeLicence());

await rm(join(out, "crawler-free.cjs"));
await rm(join(out, "sea-config.json"));

async function nodeLicence() {
  for (const path of [join(dirname(process.execPath), "LICENSE"), join(dirname(process.execPath), "..", "LICENSE")]) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text?.startsWith("Node.js is licensed for use as follows:")) return text;
  }
  const url = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
  const res = await fetch(url);
  const text = res.ok ? await res.text() : "";
  if (!text.startsWith("Node.js is licensed for use as follows:")) throw new Error(`Couldn't find Node.js's LICENSE beside ${process.execPath} or at ${url}`);
  console.log(`Node.js's licence isn't installed beside node; took the v${process.versions.node} licence from ${url}`);
  return text;
}

const output = execFileSync(program, ["--version"], { encoding: "utf8" }).trim();
if (output !== pkg.version) throw new Error(`The built program says "${output}", expected ${pkg.version}`);
const mb = ((await stat(program)).size / 1e6).toFixed(1);
console.log(`built ${program} (${mb} MB, crawler-free ${output}, Node.js ${process.versions.node}, ${process.platform}-${process.arch})`);
