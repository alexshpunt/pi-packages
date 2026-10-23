import type { ProviderErrorsServices } from "../../adapters/pi/types.js";
import type { ProviderConfigurationServices } from "../../configuration/types.js";
import type { LoggingServices } from "../../diagnostics/types.js";
import type { Effect, Scope } from "effect";

/** The part of an SDK query this module reads. Test doubles may omit accountInfo(). */
export type AccountInfoSource = {
	accountInfo?: () => Promise<{ subscriptionType?: string }>;
};

export interface PlanDetectionServices {
	/** Set by the instance that registered the provider: registers its models again
	 *  after a detected plan changes them. */
	refreshRegisteredModels: (() => void) | null;
	/** Whether an undetected plan is announced: no explicit plan, notice not yet shown. */
	shouldAnnounceUndetectedPlan: boolean;
	readonly detectPlanFromQuery: (sdkQuery: AccountInfoSource) => Effect.Effect<void>;
}

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	// Model ids whose declared 1M context Claude Code turned out not to serve;
	// forces bare id at 200K without a code change.
	forceTwoHundredK?: string[];
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

export interface PlanDetectionDependencies {
	configuration: ProviderConfigurationServices;
	diagnostics: LoggingServices;
	errors: ProviderErrorsServices;
	scope: Scope.Scope;
}
