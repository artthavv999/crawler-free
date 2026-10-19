import type { CliError } from "./errors";

export interface Io { stdout(s: string): void; stderr(s: string): void }

// Text that came from a web page (a title, an extracted fact), made safe to show in a terminal: control characters
// (which can carry escape sequences that move the cursor or change the window title) and direction overrides become
// spaces, and long values are shortened. Files and --stdout keep the data exactly as the service sent it.
export function printable(text: string, max = 200): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/g, " ").replace(/ {2,}/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Results go to stdout; progress and errors go to stderr, so piped output and --json stay clean.
// --quiet silences progress only; errors are always shown. With --json, errors are a JSON object on stdout too.
export class Ui {
  constructor(private readonly io: Io, readonly mode: { json: boolean; quiet: boolean }) {}

  progress(line: string): void {
    if (!this.mode.quiet && !this.mode.json) this.io.stderr(`${line}\n`);
  }

  out(text: string): void {
    this.io.stdout(text);
  }

  json(value: unknown): void {
    this.io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  }

  fail(e: CliError): void {
    if (this.mode.json) {
      this.json({ ok: false, error: { code: e.code, message: e.message, hint: e.hint, exitCode: e.exitCode, retryAfterSeconds: e.retryAfter } });
      return;
    }
    this.io.stderr(`Error: ${e.message}\n${e.hint ? `${e.hint}\n` : ""}`);
  }
}
