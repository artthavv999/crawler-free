import type { CliError } from "./errors";

export interface Io { stdout(s: string): void; stderr(s: string): void }

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
