import { defineConfig } from "vitest/config";

// Keeps the former `node --test` run: one file at a time, a 120000ms limit per test,
// no hook time limit, and hooks in registration order.
export default defineConfig({
    test: {
        include: ["tests/**/*.test.mjs"],
        setupFiles: ["./tests/harness/environment.mjs"],
        testTimeout: 120_000,
        hookTimeout: 0,
        fileParallelism: false,
        sequence: { hooks: "list" },
    },
});
