import { defineConfig } from "vitest/config";

// Tests import the compiled dist/, the same files Pi loads from the published package.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs"],
    setupFiles: ["./tests/support/environment.mjs"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
