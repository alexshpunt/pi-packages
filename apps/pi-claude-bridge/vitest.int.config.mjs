import { defineConfig } from "vitest/config";

// Live Claude Code integration suite, run only on request (`pnpm test`, tools/verify/run-final-validation.ts).
// It uses the real HOME and credentials, so the unit suite's isolation setup file is not applied.
export default defineConfig({
	test: {
		include: ["tests/int-*.mjs"],
		testTimeout: 0,
		hookTimeout: 0,
		sequence: { hooks: "list" },
	},
});
