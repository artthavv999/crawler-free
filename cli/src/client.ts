import { CliError, EXIT, fromApi } from "./errors";
import { VERSION } from "./version";

export const DEFAULT_API = "https://crawler-free.crawler-free.workers.dev";
// The largest answer the API gives is a crawl results page: at most 10 pages of 200,000 characters each.
const MAX_RESPONSE = 32 * 1024 * 1024;

export type Fetch = typeof fetch;

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

// Thin client for the Crawler Free API. Every web page is fetched by the server, behind its SSRF guard, robots.txt
// checks and limits; the CLI never contacts the sites being read.
export class ApiClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: Fetch;

  constructor(options: { baseUrl: string; timeoutMs?: number; fetch?: Fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  // Sends a request and returns the response, body unread. Network failures and timeouts become exit code 5.
  async request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : this.baseUrl + pathOrUrl;
    const headers = { "user-agent": `crawler-free-cli/${VERSION}`, ...(init.headers as Record<string, string> | undefined) };
    try {
      return await this.fetchFn(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw networkError(e, url, this.timeoutMs);
    }
  }

  // A JSON call: returns the success body, or throws the API's { success: false, code, error } as a CliError.
  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.jsonWithHeaders<T>(path, init)).body;
  }

  // Same, also returning the response headers (x-cache tells whether the answer came from the last hour's cache).
  async jsonWithHeaders<T>(path: string, init: RequestInit = {}): Promise<{ body: T; headers: Headers }> {
    const res = await this.request(path, init);
    let text: string;
    try {
      text = await readCapped(res);
    } catch (e) {
      throw e instanceof CliError ? e : networkError(e, res.url || this.baseUrl, this.timeoutMs);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CliError(`Unexpected answer from ${host(res.url || this.baseUrl)} (HTTP ${res.status}, not JSON).`, EXIT.failed, "BAD_RESPONSE",
        "Is the service address right? Run `crawler-free doctor` to check.");
    }
    const b = (body ?? {}) as { success?: unknown; code?: unknown; error?: unknown };
    if (!res.ok || b.success === false) {
      const wait = Number(res.headers.get("retry-after"));
      throw fromApi(res.status, typeof b.code === "string" ? b.code : `HTTP_${res.status}`, typeof b.error === "string" ? b.error : "",
        res.headers.has("retry-after") && Number.isFinite(wait) && wait >= 0 ? wait : undefined);
    }
    return { body: body as T, headers: res.headers };
  }

  get<T>(path: string): Promise<T> {
    return this.json<T>(path);
  }

  post<T>(path: string, data: unknown): Promise<T> {
    return this.json<T>(path, postInit(data));
  }

  postWithHeaders<T>(path: string, data: unknown): Promise<{ body: T; headers: Headers }> {
    return this.jsonWithHeaders<T>(path, postInit(data));
  }
}

const postInit = (data: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

function networkError(e: unknown, url: string, timeoutMs: number): CliError {
  const name = (e as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new CliError(`No answer from ${host(url)} within ${Math.round(timeoutMs / 1000)} seconds.`, EXIT.network, "TIMEOUT",
      "Check your internet connection and try again, or give it longer with --timeout.");
  }
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const why = cause?.code ?? cause?.message ?? (e as Error)?.message ?? "unknown network error";
  return new CliError(`Couldn't reach ${host(url)} (${why}).`, EXIT.network, "NETWORK",
    "Check your internet connection, or run `crawler-free doctor`.");
}

// Reads a response body as text, refusing anything larger than MAX_RESPONSE.
export async function readCapped(res: Response, max = MAX_RESPONSE): Promise<string> {
  const tooLarge = () => new CliError(`The answer from ${host(res.url) || "the service"} was larger than ${max / 1024 / 1024} MB.`, EXIT.failed, "RESPONSE_TOO_LARGE");
  if (Number(res.headers.get("content-length")) > max) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(all);
}
