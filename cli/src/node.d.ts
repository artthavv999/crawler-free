// The few Node.js built-ins the CLI uses, typed narrowly here so the CLI needs no @types/node (it has no dependencies at
// all, docs/cli-plan.md D2/D3). Fetch, URL, Response, AbortSignal and streams come from TypeScript's "dom" library.
// Add a declaration here when a later phase uses another built-in.

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  versions: { node: string };
  exitCode?: number;
  stdout: { write(s: string): boolean; isTTY?: boolean };
  stderr: { write(s: string): boolean; isTTY?: boolean };
  stdin: { isTTY?: boolean };
  cwd(): string;
  exit(code?: number): never;
};

declare module "node:util" {
  interface ParseArgsOption { type: "string" | "boolean"; short?: string; multiple?: boolean }
  export function parseArgs(config: {
    args?: string[];
    options?: Record<string, ParseArgsOption>;
    allowPositionals?: boolean;
    strict?: boolean;
  }): { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string, options?: { encoding?: "utf8"; mode?: number; flag?: string }): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
  export function rm(path: string, options?: { force?: boolean }): Promise<void>;
  export function rmdir(path: string): Promise<void>;
  export function access(path: string, mode?: number): Promise<void>;
  export function stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  export function readdir(path: string): Promise<string[]>;
}

declare module "node:readline/promises" {
  export function createInterface(options: { input: unknown; output: unknown }): {
    question(query: string): Promise<string>;
    close(): void;
    on(event: "SIGINT" | "close", listener: () => void): void;
  };
}

declare module "node:fs" {
  export const constants: { W_OK: number; R_OK: number };
}

declare module "node:sea" {
  export function isSea(): boolean;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  interface PathApi { join(...parts: string[]): string; dirname(p: string): string; resolve(...parts: string[]): string }
  export const win32: PathApi;
  export const posix: PathApi;
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function resolve(...parts: string[]): string;
  export const sep: string;
}
