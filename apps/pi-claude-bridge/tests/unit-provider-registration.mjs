#!/usr/bin/env node

/**
 * Provider registration across module instances (issue #91's foreground failure).
 *
 * The first bridge instance registers the claude-bridge provider at activation.
 * A later instance — a subagent session that loaded this module fresh — must
 * decide at session_start based on who owns its session's model registry:
 * hosts that pass the parent's registry down already have the provider
 * (re-registering would overwrite the parent's pinned stream fn), while hosts
 * that give the child its own registry need it registered or every
 * claude-bridge/* dispatch fails with "Model not found".
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { summarySessionFor } from "../src/adapters/pi/session-cwd.js";

const PROVIDER_ID = "claude-bridge";

const { default: activate } = await import("../src/index.js");

function activateWithMockPi(activateFn, options = {}) {
	// pi appends handlers (a later bridge instance registers two session_start
	// handlers: clearSession + deferred registration), so the mock does too.
	const handlers = new Map();
	const registered = [];
	(activateFn ?? activate)({
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider: (name, config) => registered.push({ name, config }),
		registerTool: () => { throw new Error("bridge must not register tools"); },
	});
	const emit = (event, ...args) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};
	return { handlers, registered, emit };
}

function registryWith(provider) {
	return { getProvider: (id) => (id === provider ? { name: provider } : undefined) };
}

describe("provider registration across module instances", () => {
	it("first instance registers at activation", () => {
		const { registered } = activateWithMockPi();
		expect(registered.length, "exactly one activation-time registration").toBe(1);
		expect(registered[0].name).toBe(PROVIDER_ID);
	});

	it("later instance registers at session_start when its registry lacks the provider (#91)", async () => {
		// A fresh module instance: the activate-time registration is skipped, and
		// the decision moves to session_start with the session's own registry.
		const { default: activateFresh } = await import("../src/index.js?own-registry-child");
		const { registered, emit } = activateWithMockPi(activateFresh);
		expect(registered.length, "no activation-time registration for a later instance").toBe(0);

		emit("session_start", {}, {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "own-registry-child" },
			modelRegistry: registryWith("other-provider"),
		});
		expect(registered.length, "session_start registers into the empty registry").toBe(1);
		expect(registered[0].name).toBe(PROVIDER_ID);
		expect(registered[0].config.streamSimple, "the registration carries this instance's stream fn").toBeTruthy();
	});

	it("later instance does not re-register when the registry already has the provider", async () => {
		const { default: activateFresh } = await import("../src/index.js?shared-registry-child");
		const { registered, emit } = activateWithMockPi(activateFresh);

		// Host passed the parent's registry down: the provider is already there.
		const context = {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "shared-registry-child" },
			modelRegistry: registryWith(PROVIDER_ID),
		};
		emit("session_start", {}, context);
		expect(registered.length, "no overwrite of the parent's registration").toBe(0);

		// Repeated session starts stay idempotent.
		emit("session_start", {}, context);
		expect(registered.length, "still no registration on a later session_start").toBe(0);
	});
});

async function withLegacyNoticeConfig(config, run) {
	const cwd = mkdtempSync(join(tmpdir(), "bridge-notice-"));
	const path = join(cwd, CONFIG_DIR_NAME, "claude-bridge.json");
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	const contents = JSON.stringify(config);
	writeFileSync(path, contents);
	const key = Symbol.for("claude-bridge:removedToolNoticeShown");
	const previous = globalThis[key];
	delete globalThis[key];
	const notices = [];
	const context = (mode) => ({
		cwd, mode, ui: { notify: (...args) => notices.push(args) },
		sessionManager: { getSessionId: () => "notice-session" },
		modelRegistry: registryWith(PROVIDER_ID),
	});
	try {
		await run({ context, notices });
		expect(readFileSync(path, "utf8"), "notice must not persist state in config").toBe(contents);
	} finally {
		if (previous === undefined) delete globalThis[key];
		else globalThis[key] = previous;
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("native summary hooks", () => {
	it("records the owning session without taking over compaction or navigation", () => {
		const { handlers } = activateWithMockPi();
		for (const event of ["session_before_compact", "session_before_tree"]) {
			const signal = new AbortController().signal;
			const registered = handlers.get(event);
			expect(registered.length, "only the ownership observer may remain").toBe(1);
			expect(registered[0]({ signal }, { sessionManager: { getSessionId: () => "summary-owner" } })).toBe(undefined);
			expect(summarySessionFor(signal)).toBe("summary-owner");
		}
	});
});

describe("removed tool notice", () => {
	it("notifies once per process across sessions and module reloads", () =>
		withLegacyNoticeConfig({ askClaude: { enabled: true } }, async ({ context, notices }) => {
			const first = activateWithMockPi();
			first.emit("session_start", {}, context("tui"));
			first.emit("session_start", {}, context("tui"));
			const { default: reloaded } = await import("../src/index.js?removed-tool-notice");
			activateWithMockPi(reloaded).emit("session_start", {}, context("tui"));
			expect(notices.length).toBe(1);
			expect(notices[0][0]).toMatch(/AskClaude has been removed/);
		}));

	it("does not consume the notice in RPC, JSON or print mode", () =>
		withLegacyNoticeConfig({ askClaude: { enabled: true } }, ({ context, notices }) => {
			const extension = activateWithMockPi();
			for (const mode of ["rpc", "json", "print"]) extension.emit("session_start", {}, context(mode));
			expect(notices.length).toBe(0);
			extension.emit("session_start", {}, context("tui"));
			expect(notices.length).toBe(1);
		}));

	it("stays silent without the removed setting", () =>
		withLegacyNoticeConfig({}, ({ context, notices }) => {
			activateWithMockPi().emit("session_start", {}, context("tui"));
			expect(notices.length).toBe(0);
		}));
});
