export type CheckMode = "offline" | "spawn" | "live";
export type CheckStatus = "pass" | "fail" | "skipped";
export type Facts = Record<string, unknown>;

export interface CheckContext {
	appDir: string;
	modelId: string;
	isLive: boolean;
	apiCalls: number;
}

/** "cache": optional cache measurements, left out of --all and run with --cache. */
export type CheckGroup = "cache";

export interface VerificationCheck {
	name: string;
	mode: CheckMode;
	group?: CheckGroup;
	inputs: Facts;
	expected: Facts;
	run(context: CheckContext): Promise<Facts>;
}

export interface CheckResult {
	name: string;
	mode: CheckMode;
	inputs: Facts;
	expected: Facts;
	observed: Facts;
	status: CheckStatus;
	apiCalls: number;
}

/** Codes are deliberately authored, not copied from SDK errors or request data. */
export class VerificationError extends Error {
	readonly observed: Facts;
	constructor(readonly code: string, observed: Facts = {}) {
		super(code);
		this.name = "VerificationError";
		this.observed = { ...observed };
	}
}

export class EnvironmentError extends VerificationError {
	constructor(code: string, observed: Facts = {}) { super(code, observed); this.name = "EnvironmentError"; }
}

export function expect(condition: unknown, code: string, observed: Facts = {}): asserts condition {
	if (!condition) throw new VerificationError(code, observed);
}
