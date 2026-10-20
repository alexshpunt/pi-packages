import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { CheckResult } from "./types.js";

export function fingerprint(value: string | Buffer): { sha256: string; byteLength: number } {
	const bytes = typeof value === "string" ? Buffer.from(value) : value;
	return { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length };
}

export function sourceRevision(appDir: string) {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: appDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	const root = git("rev-parse", "--show-toplevel").trim();
	const prefix = relative(root, appDir);
	const paths = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z", "--", appDir).split("\0").filter(Boolean))].sort();
	const hash = createHash("sha256");
	for (const path of paths) {
		const absolute = join(root, path);
		const name = relative(prefix, path);
		try {
			const stat = lstatSync(absolute);
			const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
			hash.update(JSON.stringify({ name, kind: stat.isSymbolicLink() ? "link" : "file", executable: stat.mode & 0o111, bytes: content.length })).update("\0");
			hash.update(content).update("\0");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			hash.update(JSON.stringify({ name, kind: "deleted" })).update("\0");
		}
	}
	return {
		head: git("rev-parse", "HEAD").trim(),
		isDirty: git("status", "--porcelain", "--untracked-files=all", "--", appDir).length > 0,
		contentHash: hash.digest("hex"),
	};
}

export function versions(appDir: string) {
	const pkg = (name: string) => JSON.parse(readFileSync(join(appDir, "node_modules", name, "package.json"), "utf8"));
	const sdk = pkg("@anthropic-ai/claude-agent-sdk");
	return { node: process.version, pi: pkg("@earendil-works/pi-coding-agent").version as string, sdk: sdk.version as string, claudeCode: sdk.claudeCodeVersion as string };
}

/** Never serialize raw transport objects or accidentally returned credentials. */
export function isReportSafe(value: unknown): boolean {
	const seen = new Set<object>();
	function visit(item: unknown): boolean {
		if (typeof item === "string") return !/sk-ant|bearer|authorization/i.test(item);
		if (typeof item === "number") return Number.isFinite(item);
		if (item === null || item === undefined || typeof item === "boolean") return true;
		if (typeof item !== "object" || seen.has(item)) return false;
		if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
		seen.add(item);
		const isSafe = Array.isArray(item) ? item.every(visit) : Object.entries(item).every(([key, child]) =>
			!/^(?:headers|requestHeaders|responseHeaders|prompt|rawPrompt|body|requestBody|responseBody|messages|content)$/i.test(key)
			&& visit(key) && visit(child));
		seen.delete(item);
		return isSafe;
	}
	return visit(value);
}

export function safeResult(result: CheckResult): CheckResult {
	if (isReportSafe(result)) return result;
	return { name: result.name, mode: result.mode, inputs: {}, expected: {}, observed: { errorCode: "unsafe-report-data" }, status: "fail", apiCalls: result.apiCalls };
}

export function makeReport(appDir: string, checks: CheckResult[] = [], apiCalls = 0, errorCode?: string) {
	return {
		schemaVersion: 1,
		sourceRevision: sourceRevision(appDir),
		versions: versions(appDir),
		checks,
		apiCalls,
		...(errorCode ? { errorCode } : {}),
	};
}

export function writeReport(path: string, report: ReturnType<typeof makeReport>): void {
	if (!isReportSafe(report)) throw new Error("unsafe-report-data");
	const absolute = resolve(path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
