import { copyFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { createSdkQueryClient } from "../../src/adapters/claude/client.js";
import { OBSERVED_ENV_KEYS } from "./capture.js";
import { expect } from "./types.js";
import type { VerificationWorkspace } from "./workspace.js";

export interface SpawnCapture { argv: string[]; env: Record<string, string>; }

export function flagValues(argv: string[], name: string): (string | null)[] {
	const values: (string | null)[] = [];
	const flag = `--${name}`;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith(`${flag}=`)) values.push(argv[i].slice(flag.length + 1));
		else if (argv[i] === flag) values.push(i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : null);
	}
	return values;
}

/** Final-consumer observation through the real SDK and its supported executable override. */
export async function captureSpawn(options: Options, workspace: VerificationWorkspace, envKeys: readonly string[] = OBSERVED_ENV_KEYS): Promise<SpawnCapture> {
	const wrapper = join(workspace.root, "capture-cli.mjs");
	const output = join(workspace.root, `spawn-${randomUUID()}.json`);
	copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/capture-cli.mjs"), wrapper);
	const client = createSdkQueryClient();
	let active: Query | undefined;
	const timeout = setTimeout(() => active?.close(), 10000);
	try {
		active = client.invokeQuery({ prompt: "Offline spawn fixture.", options: {
			...options, pathToClaudeCodeExecutable: wrapper, executable: "node",
			env: { ...options.env, BRIDGE_VERIFY_CAPTURE: output, BRIDGE_VERIFY_ENV_KEYS: JSON.stringify(envKeys) },
			stderr: options.stderr ?? (() => {}),
		} });
		try { for await (const _ of active) {} }
		catch { /* The wrapper deliberately exits without an SDK initialization reply. */ }
	} finally { clearTimeout(timeout); active?.close(); }
	let capture: SpawnCapture;
	try { capture = JSON.parse(readFileSync(output, "utf8")); }
	catch { throw new Error("spawn-capture-unavailable"); }
	expect(Array.isArray(capture.argv) && capture.argv.every(value => typeof value === "string") && !!capture.env, "invalid-spawn-capture");
	return capture;
}
