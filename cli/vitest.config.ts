import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The CLI runs on Node.js, so its tests do too (the Worker's tests use the Workers runtime; see ../vitest.config.ts).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
