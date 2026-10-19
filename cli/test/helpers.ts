import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Deps } from "../src/main";

export interface Hit { method: string; url: string; headers: IncomingMessage["headers"]; body: string }

// A local stand-in for the Crawler Free API on 127.0.0.1 and a random port. Tests never reach the real service.
export async function mockApi(handler: (hit: Hit, res: ServerResponse) => void) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const hit = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      hits.push(hit);
      handler(hit, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
};

// Behaves like the real API for what `doctor` touches: the static page and a status check for an unknown job.
export const healthyApi = (hit: Hit, res: ServerResponse) => {
  if (hit.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Crawler Free</title>"); return; }
  if (hit.url.startsWith("/v2/crawl/")) { sendJson(res, 404, { success: false, code: "NOT_FOUND", error: "crawl job not found (jobs expire after 24 h)" }); return; }
  sendJson(res, 404, { success: false, code: "NOT_FOUND", error: `no route ${hit.method} ${hit.url}` });
};

export const tempDir = () => mkdtemp(join(tmpdir(), "crawler-free-cli-"));

// Runs the CLI in-process with captured output. Settings live in a fresh temporary folder unless `env` says otherwise.
export async function run(argv: string[], over: Partial<Deps> = {}) {
  const home = await tempDir();
  let stdout = "", stderr = "";
  const deps: Deps = {
    argv,
    env: { APPDATA: join(home, "AppData"), XDG_CONFIG_HOME: join(home, ".config") },
    platform: process.platform,
    homedir: home,
    cwd: home,
    nodeVersion: "22.11.0",
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
    ...over,
  };
  const code = await main(deps);
  return { code, stdout, stderr, home };
}
