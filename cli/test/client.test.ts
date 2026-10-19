import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient, readCapped } from "../src/client";
import { CliError, EXIT } from "../src/errors";
import { VERSION } from "../src/version";
import { mockApi, sendJson } from "./helpers";

let closeApi: (() => Promise<void>) | undefined;
afterEach(async () => { await closeApi?.(); closeApi = undefined; });

const api = async (handler: Parameters<typeof mockApi>[0]) => {
  const m = await mockApi(handler);
  closeApi = m.close;
  return { ...m, client: new ApiClient({ baseUrl: `${m.url}/`, timeoutMs: 2000 }) };
};
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e: CliError) => e);

describe("API client", () => {
  it("sends JSON, identifies itself, and sends no browser headers (so the cross-site check never applies)", async () => {
    const { client, hits } = await api((_hit, res) => sendJson(res, 200, { success: true, data: { markdown: "# Hi" } }));
    expect(await client.post("/v2/scrape", { url: "https://example.com" })).toEqual({ success: true, data: { markdown: "# Hi" } });
    expect(hits[0]).toMatchObject({ method: "POST", url: "/v2/scrape", body: '{"url":"https://example.com"}' });
    expect(hits[0].headers["content-type"]).toBe("application/json");
    expect(hits[0].headers["user-agent"]).toBe(`crawler-free-cli/${VERSION}`);
    expect(hits[0].headers.origin).toBeUndefined();
    expect(hits[0].headers["sec-fetch-site"]).toBeUndefined();
  });

  it("turns API errors into exit codes, keeping the API's message and Retry-After", async () => {
    const answers: Record<string, [number, string, Record<string, string>?]> = {
      "/limit": [429, "RATE_LIMITED", { "retry-after": "42" }],
      "/robots": [403, "ROBOTS_DISALLOWED"],
      "/bad": [400, "BAD_REQUEST"],
      "/budget": [503, "DAILY_BUDGET_EXHAUSTED", { "retry-after": "3600" }],
      "/slow": [408, "SCRAPE_TIMEOUT"],
      "/broken": [500, "SCRAPE_FAILED"],
    };
    const { client } = await api((hit, res) => { const [status, code, headers] = answers[hit.url]; sendJson(res, status, { success: false, code, error: `message for ${code}` }, headers); });
    expect(await failure(client.get("/limit"))).toMatchObject({ exitCode: EXIT.limit, code: "RATE_LIMITED", message: "message for RATE_LIMITED", retryAfter: 42 });
    expect(await failure(client.get("/robots"))).toMatchObject({ exitCode: EXIT.refused, code: "ROBOTS_DISALLOWED" });
    expect(await failure(client.get("/bad"))).toMatchObject({ exitCode: EXIT.usage });
    expect(await failure(client.get("/budget"))).toMatchObject({ exitCode: EXIT.limit, retryAfter: 3600 });
    expect(await failure(client.get("/slow"))).toMatchObject({ exitCode: EXIT.network });
    expect(await failure(client.get("/broken"))).toMatchObject({ exitCode: EXIT.failed, code: "SCRAPE_FAILED" });
  });

  it("treats non-JSON, truncated and success:false answers as errors", async () => {
    const { client } = await api((hit, res) => {
      if (hit.url === "/html") { res.writeHead(502, { "content-type": "text/html" }); res.end("<h1>Bad gateway</h1>"); return; }
      if (hit.url === "/cut") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"success":true,"data":{"mark'); return; }
      sendJson(res, 200, { success: false });
    });
    expect(await failure(client.get("/html"))).toMatchObject({ exitCode: EXIT.failed, code: "BAD_RESPONSE" });
    expect(await failure(client.get("/cut"))).toMatchObject({ code: "BAD_RESPONSE" });
    expect(await failure(client.get("/flag"))).toMatchObject({ exitCode: EXIT.failed, code: "HTTP_200" });
  });

  it("gives up on a silent server after the timeout (exit 5)", async () => {
    const m = await mockApi(() => { /* never answers */ });
    closeApi = m.close;
    const started = Date.now();
    const err = await failure(new ApiClient({ baseUrl: m.url, timeoutMs: 300 }).get("/v2/crawl/x"));
    expect(err).toMatchObject({ exitCode: EXIT.network, code: "TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports a server that can't be reached (exit 5)", async () => {
    const port = await new Promise<number>((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
    const err = await failure(new ApiClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 }).get("/"));
    expect(err).toMatchObject({ exitCode: EXIT.network, code: "NETWORK" });
    expect(err.message).toMatch(/^Couldn't reach 127\.0\.0\.1:\d+ \(/);
  });

  it("refuses answers larger than the cap, declared or streamed", async () => {
    await expect(readCapped(new Response("x".repeat(2000)), 1000)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await expect(readCapped(new Response("x", { headers: { "content-length": "999999" } }), 1000)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(await readCapped(new Response("héllo"), 1000)).toBe("héllo");
  });
});
