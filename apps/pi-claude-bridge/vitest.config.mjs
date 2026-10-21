import { defineConfig } from "vitest/config";

// Unit suite. Like the former `node --test` run, tests have no default time limit and hooks run in registration order.
export default defineConfig({
	test: {
		include: ["tests/unit-*.mjs"],
		// Runs first in every test file so tests never touch the developer's real HOME/pi/claude state.
		setupFiles: ["./tests/lib/setup.mjs"],
		testTimeout: 0,
		hookTimeout: 0,
		sequence: { hooks: "list" },
	},
});
