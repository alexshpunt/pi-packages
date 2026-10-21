import { defineConfig } from "vitest/config";

// Like the former `node --test` run, tests have no default time limit and hooks run in registration order.
export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    testTimeout: 0,
    hookTimeout: 0,
    sequence: { hooks: "list" },
  },
});
