// Exit codes scripts can rely on (docs/cli-plan.md, D10).
export const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3, limit: 4, network: 5, output: 6 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// Every failure the user sees: a plain-English message, an optional next step, a stable code and the exit code.
export class CliError extends Error {
  constructor(
    message: string,
    public exitCode: ExitCode,
    public code = "CLI_ERROR",
    public hint?: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

const REFUSED: Record<string, string> = {
  URL_BLOCKED: "Crawler Free only reads public web addresses: not local, private or IP-address hosts.",
  ROBOTS_DISALLOWED: "The site's robots.txt asks crawlers not to read this page, and Crawler Free respects that.",
  BLOCKED: "The site refused the request. Crawler Free never gets around blocks, logins or bot protection.",
};
const LIMIT = new Set(["RATE_LIMITED", "DAILY_BUDGET_EXHAUSTED", "EXTRACT_BUDGET_EXHAUSTED", "RENDER_BUDGET_EXHAUSTED", "RENDER_BUSY"]);

// An API error ({ success: false, code, error }) as a CLI error. The API's message is already written for people
// (rate limits say when to try again), so it is shown as is.
export function fromApi(status: number, code: string, message: string, retryAfter?: number): CliError {
  const text = message || `The server answered HTTP ${status}.`;
  if (code in REFUSED) return new CliError(text, EXIT.refused, code, REFUSED[code]);
  if (LIMIT.has(code)) {
    return new CliError(text, EXIT.limit, code, "Crawler Free is a free service shared by everyone, with daily limits.", retryAfter);
  }
  if (code === "BAD_REQUEST") return new CliError(text, EXIT.usage, code);
  if (code === "SCRAPE_TIMEOUT") return new CliError(text, EXIT.network, code, "The site took too long to answer. Try again later.");
  return new CliError(text, EXIT.failed, code);
}
