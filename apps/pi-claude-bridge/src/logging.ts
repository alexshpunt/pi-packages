import { debugLogPath } from "./log-paths.js";
import { diagLogPath } from "./log-paths.js";
import { appendFileSync } from "fs";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { join } from "path";



export interface LoggingServices {
	readonly DEBUG: boolean;
	readonly debug: (...args: unknown[]) => void;
	readonly diagDump: (label: string, data: Record<string, unknown>) => void;
	readonly makeCliDebugOptions: (tag: string) => { debug?: boolean; debugFile?: string; stderr?: (data: string) => void };
	readonly moduleInstanceId: string;
}

export function createLogging(): LoggingServices {
	// --- Debug logging ---
	// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to the bridge log in pi's agent
	// dir (log-paths.ts), not a fixed ~/.pi/agent.

	const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";

	// Unique per module evaluation — confirms whether subagents share module state
	const moduleInstanceId = Math.random().toString(36).slice(2, 8);

	function debug(...args: unknown[]) {
		if (!DEBUG) return;
		try {
			const logPath = debugLogPath();
			mkdirSync(dirname(logPath), { recursive: true });
			const ts = new Date().toISOString();
			const fmt = (a: unknown): string => {
				if (typeof a === "string") return a;
				if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
				return JSON.stringify(a);
			};
			const msg = args.map(fmt).join(" ");
			appendFileSync(logPath, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
		} catch { /* Diagnostics must not interrupt the provider or write into pi's TUI. */ }
	}

	// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
	// CLI subprocess to write its own debug log to a file we choose, and also
	// forward its stderr into our debug stream. Drops straight into the real SDK's
	// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
	// stderr). Without this, CC's internal view of the world is invisible to us
	// and "No conversation found" / empty-error reports are unactionable.
	let nextCliDebugSeq = 1;

	function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
		if (!DEBUG) return {};
		try {
			const seq = nextCliDebugSeq++;
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			const logDir = join(dirname(debugLogPath()), "cc-cli-logs");
			mkdirSync(logDir, { recursive: true });
			const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
			debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
			return {
				debug: true,
				debugFile,
				stderr: (data: string) => {
					for (const line of data.split(/\r?\n/)) {
						if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
					}
				},
			};
		} catch { return {}; }
	}

	/** Best-effort diagnostic dump even with DEBUG off: errors must not mask the
	 *  provider failure that callers are trying to report. */
	function diagDump(label: string, data: Record<string, unknown>) {
		try {
			const ts = new Date().toISOString();
			const entry = { ts, moduleInstanceId, label, ...data };
			const logPath = diagLogPath();
			mkdirSync(dirname(logPath), { recursive: true });
			appendFileSync(logPath, JSON.stringify(entry) + "\n");
			debug(`DIAG: ${label} (see ${logPath})`);
		} catch { /* Best-effort diagnostics only. */ }
	}

	return {
		DEBUG,
		debug,
		diagDump,
		makeCliDebugOptions,
		moduleInstanceId,
	};
}
