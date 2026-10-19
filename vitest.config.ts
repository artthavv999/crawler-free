import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// CI sets CRAWLER_WRANGLER_CONFIG=wrangler.ci.toml: no Workers AI binding, which needs a Cloudflare login.
const configPath = process.env.CRAWLER_WRANGLER_CONFIG ?? "./wrangler.toml";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath } })],
  // One test file at a time: two Workers runtimes in parallel (each with its own remote AI session) kept the runner
  // from exiting on Windows.
  test: { include: ["test/**/*.test.ts"], fileParallelism: false },
});
