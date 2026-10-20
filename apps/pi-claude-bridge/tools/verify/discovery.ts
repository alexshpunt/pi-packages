import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EnvironmentError, type VerificationCheck } from "./types.js";

export async function discoverChecks(directory: string): Promise<VerificationCheck[]> {
	const checks: VerificationCheck[] = [];
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !/^[a-z0-9][a-z0-9-]*\.ts$/.test(entry.name)) continue;
		const check = (await import(pathToFileURL(join(directory, entry.name)).href)).default as VerificationCheck;
		if (!check || check.name !== entry.name.slice(0, -3) || /sk-ant|bearer|authorization/i.test(check.name)
			|| !["offline", "spawn", "live"].includes(check.mode) || (check.group !== undefined && check.group !== "cache") || typeof check.run !== "function"
			|| !check.inputs || !check.expected) throw new EnvironmentError("invalid-check-definition");
		if (checks.some(existing => existing.name === check.name)) throw new EnvironmentError("duplicate-check-name");
		checks.push(check);
	}
	return checks;
}
