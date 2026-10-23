import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectDir } from "cc-session-io";
import { forgetSessionCwd, rememberSessionCwd } from "../../src/adapters/pi/session-cwd.js";
import { expect, VerificationError, type Facts } from "./types.js";

export interface VerificationWorkspace {
	root: string;
	cwd: string;
	sessionId: string;
	ccSessionDir: string;
}

function modification(path: string): string | null {
	try { return statSync(path, { bigint: true }).mtimeNs.toString(); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Process-local env/cwd changes are serialized by the CLI and restored even on failure. */
export async function withWorkspace(isLive: boolean, run: (workspace: VerificationWorkspace) => Promise<Facts>): Promise<Facts> {
	const beforeEnv = { ...process.env };
	const beforeCwd = process.cwd();
	const protectedFiles = [join(homedir(), ".claude/settings.json"), join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "claude-bridge.json")];
	const mtimes = protectedFiles.map(modification);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cc-bridge-verify-")));
	const cwd = join(root, "work");
	const sessionId = randomUUID();
	let ccSessionDir: string | undefined;
	let hasOwnedSessionDir = false;
	let result: Facts | undefined;
	let failure: unknown;
	try {
		for (const folder of [cwd, join(root, "agent"), join(root, "claude")]) mkdirSync(folder, { recursive: true });
		if (!isLive) {
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, { PATH: beforeEnv.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude") });
		}
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		for (const key of ["CLAUDE_BRIDGE_DEBUG", "CLAUDE_BRIDGE_DEBUG_PATH", "CLAUDE_BRIDGE_RECORD_STREAM"]) delete process.env[key];
		process.chdir(cwd);
		ccSessionDir = getProjectDir(cwd);
		expect(!existsSync(ccSessionDir), "temporary-session-directory-already-exists");
		hasOwnedSessionDir = true;
		rememberSessionCwd(sessionId, cwd);
		result = await run({ root, cwd, sessionId, ccSessionDir });
	} catch (error) { failure = error; }
	finally {
		try {
			forgetSessionCwd(sessionId);
			if (hasOwnedSessionDir) rmSync(ccSessionDir!, { recursive: true, force: true });
		} catch (error) { failure ??= error; }
		finally {
			process.chdir(beforeCwd);
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, beforeEnv);
			try { rmSync(root, { recursive: true, force: true }); } catch (error) { failure ??= error; }
		}
	}
	const cleanup = {
		temporaryCwdRemoved: !existsSync(root),
		ccSessionDirectoryRemoved: hasOwnedSessionDir ? !existsSync(ccSessionDir!) : null,
		userSettingsUnchanged: protectedFiles.every((path, i) => modification(path) === mtimes[i]),
	};
	expect(cleanup.userSettingsUnchanged, "user-settings-modified", { cleanup });
	expect(cleanup.temporaryCwdRemoved && (!hasOwnedSessionDir || cleanup.ccSessionDirectoryRemoved), "temporary-state-not-cleaned", { cleanup });
	if (failure) {
		const error = failure instanceof VerificationError ? failure : new VerificationError("verification-workspace-failed");
		Object.assign(error.observed, { cleanup });
		throw error;
	}
	return { ...result, cleanup };
}
