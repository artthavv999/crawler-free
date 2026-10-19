// Builds the web page's scripts into public/ (run `npm run build:ui`, then commit public/). The Worker and
// `wrangler deploy` are untouched: public/ is served as static files exactly as before.
import { build } from "esbuild";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { webSvg } from "./graph.js";

await rm("public/chunks", { recursive: true, force: true });
const common = { bundle: true, minify: true, target: ["es2022"], legalComments: "eof", logLevel: "warning" };
// app.js loads first; motion (gsap + lenis) and the WebGL hero (ogl) are split out and loaded only when used.
await build({ ...common, entryPoints: { app: "ui/app.js" }, outdir: "public", format: "esm", splitting: true, chunkNames: "chunks/[name]-[hash]" });
await build({ ...common, entryPoints: { boot: "ui/boot.js" }, outdir: "public", format: "iife" });
await writeFile("public/web.svg", webSvg());

const files = ["public/boot.js", "public/app.js", ...(await readdir("public/chunks")).map((f) => `public/chunks/${f}`)];
let total = 0;
for (const f of files) {
  const gz = gzipSync(await readFile(f)).length;
  total += gz;
  console.log(`${f.padEnd(44)} ${(gz / 1024).toFixed(1).padStart(6)} KB gzipped`);
}
console.log(`${"total JavaScript".padEnd(44)} ${(total / 1024).toFixed(1).padStart(6)} KB gzipped (budget 300 KB)`);
