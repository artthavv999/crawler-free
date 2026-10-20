import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/errors";
import { OUTPUT_DIR, replaceFile } from "../src/output";
import { mockApi, run, sendJson, tempDir, type Hit } from "./helpers";

// Audit finding E (docs/beginner-cli-plan.md): replacing a file never writes through a symbolic link or into a folder,
// and never leaves half-written or temporary files. Windows creates symbolic links only with Developer Mode or admin
// rights, so those tests skip themselves there; the Linux and macOS CI jobs run them.
let closeApi: (() => Promise<void>) | undefined;
afterEach(async () => { await closeApi?.(); closeApi = undefined; });

const PAGE = { markdown: "# New", metadata: { title: "New", url: "https://example.com/", sourceURL: "https://example.com/" } };
const api = async () => {
  const m = await mockApi((hit: Hit, res) => {
    if (hit.url === "/v2/scrape") return sendJson(res, 200, { success: true, data: PAGE });
    if (hit.method === "POST" && hit.url === "/v2/crawl") return sendJson(res, 200, { success: true, id: "job-1", url: `${m.url}/v2/crawl/job-1` });
    sendJson(res, 200, { success: true, status: "completed", completed: 1, total: 1, failed: 0, next: null, data: [PAGE] });
  });
  closeApi = m.close;
  return m;
};
const tryLink = (target: string, path: string) => symlink(target, path).then(() => true, () => false);
const noTempFiles = async (dir: string) => expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);

describe("replacing files", () => {
  it("replaces the content and leaves no temporary file", async () => {
    const dir = await tempDir();
    const path = join(dir, "page.md");
    await writeFile(path, "old");
    await replaceFile(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
    await noTempFiles(dir);
  });

  it("replaces a symbolic link at the target instead of writing through it", async (ctx) => {
    const home = await tempDir();
    const secret = join(home, "secret.txt");
    await writeFile(secret, "keep me");
    const target = join(home, "out.md");
    if (!(await tryLink(secret, target))) return ctx.skip();
    const m = await api();
    const r = await run(["scrape", "https://example.com/", "-o", "out.md", "--force", "--api-url", m.url], { cwd: home });
    expect(r.code).toBe(EXIT.ok);
    expect(await readFile(secret, "utf8")).toBe("keep me");
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await readFile(target, "utf8")).toBe("# New\n");
    await noTempFiles(home);
  });

  it("refuses to replace a folder that has the generated file name, even with --force", async () => {
    const home = await tempDir();
    const taken = join(home, OUTPUT_DIR, "example.com.md");
    await mkdir(taken, { recursive: true });
    const m = await api();
    const r = await run(["scrape", "https://example.com/", "--force", "--api-url", m.url], { cwd: home });
    expect(r.code).toBe(EXIT.output);
    expect(r.stderr).toContain(`${taken} is a folder, so nothing was saved there.`);
    expect(await readdir(taken)).toEqual([]);
    await noTempFiles(join(home, OUTPUT_DIR));
  });

  it("crawl --force replaces a symbolic link among its files without touching what it points to", async (ctx) => {
    const home = await tempDir();
    const folder = join(home, OUTPUT_DIR, "example.com-crawl");
    await mkdir(folder, { recursive: true });
    const secret = join(home, "secret.txt");
    await writeFile(secret, "keep me");
    if (!(await tryLink(secret, join(folder, "example.com.md")))) return ctx.skip();
    const m = await api();
    const c = { sleep: async () => {}, now: () => 0 };
    const r = await run(["crawl", "https://example.com/", "--force", "--api-url", m.url], { cwd: home, clock: c });
    expect(r.code).toBe(EXIT.ok);
    expect(await readFile(secret, "utf8")).toBe("keep me");
    expect(await readFile(join(folder, "example.com.md"), "utf8")).toBe("# New\n");
    await noTempFiles(folder);
  });

  it("saves into folders whose names have spaces and accents", async () => {
    const home = await tempDir();
    const m = await api();
    const r = await run(["scrape", "https://example.com/", "-o", "my results ü/", "--api-url", m.url], { cwd: home });
    expect(r.code).toBe(EXIT.ok);
    expect(await readFile(join(home, "my results ü", "example.com.md"), "utf8")).toBe("# New\n");
    const again = await run(["scrape", "https://example.com/", "-o", "my results ü/", "--force", "--api-url", m.url], { cwd: home });
    expect(again.code).toBe(EXIT.ok);
    await noTempFiles(join(home, "my results ü"));
  });
});
