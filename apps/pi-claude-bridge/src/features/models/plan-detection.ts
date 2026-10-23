import { Cause, Context as ServiceContext, Effect, Exit, Layer, Scope } from "effect";
import type { AccountInfoSource, PlanDetectionDependencies, PlanDetectionServices } from "./types.js";
import { fromPromise } from "../../adapters/effects.js";
import { Configuration } from "../../configuration/service.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { Errors } from "../../adapters/pi/error-mapping.js";
import { planFromSubscriptionType, recordDetectedPlan } from "../../adapters/storage/configuration.js";

const UNDETECTED_PLAN_NOTICE =
	'Could not tell your Claude plan from the Claude Code login. On Max or Team Premium, set provider.plan to "max" to use Opus 4.6 with 1M context.';

export function createPlanDetection({ configuration, diagnostics, errors, scope }: PlanDetectionDependencies): PlanDetectionServices {
	let refreshRegisteredModels: (() => void) | null = null;
	let shouldAnnounceUndetectedPlan = false;
	let isDetectionStarted = false;

	function announceUndetectedPlan(): void {
		if (!shouldAnnounceUndetectedPlan) return;
		shouldAnnounceUndetectedPlan = false;
		// Shown by the next provider call's showStartupNoticeOnce, like the other notices.
		configuration.pendingNotices.push(UNDETECTED_PLAN_NOTICE);
	}

	function detectPlan(sdkQuery: Required<AccountInfoSource>): Effect.Effect<void> {
		return Effect.gen(function* () {
			const { subscriptionType } = yield* fromPromise(() => sdkQuery.accountInfo());
		const plan = planFromSubscriptionType(subscriptionType);
		diagnostics.debug(`plan: subscriptionType=${subscriptionType ?? "(absent)"} -> ${plan ?? "undetected"}`);
		if (!plan) {
			announceUndetectedPlan();
			return;
		}
		shouldAnnounceUndetectedPlan = false;
		try {
			recordDetectedPlan(plan);
		} catch (error) {
			diagnostics.debug(`plan: could not record ${plan}: ${errors.errorMessage(error)}`);
		}
		if (plan === configuration.longContextSettings.plan) return;
		configuration.longContextSettings = { ...configuration.longContextSettings, plan };
		try {
			refreshRegisteredModels?.();
		} catch (error) {
			diagnostics.debug(`plan: could not register models for ${plan}: ${errors.errorMessage(error)}`);
		}
		}).pipe(
			Effect.onExit((exit) => Effect.sync(() => {
				if (Exit.isFailure(exit)) {
					isDetectionStarted = false;
					diagnostics.debug(`plan: accountInfo failed, retrying on the next query: ${errors.errorMessage(Cause.squash(exit.cause))}`);
				}
			})),
			Effect.catchCause(() => Effect.void),
		);
	}

	/** Read the plan once per runtime from the first provider query. The query is already
	 *  running, so accountInfo() adds no model request. An explicit provider.plan wins and
	 *  skips detection. */
	function detectPlanFromQuery(sdkQuery: AccountInfoSource): Effect.Effect<void> {
		return Effect.gen(function* () {
			if (isDetectionStarted || configuration.providerSettings.plan !== undefined) return;
			const { accountInfo } = sdkQuery;
			if (typeof accountInfo !== "function") return;
			isDetectionStarted = true;
			yield* Effect.forkIn(detectPlan({ accountInfo: () => accountInfo.call(sdkQuery) }), scope, { startImmediately: true });
		});
	}

	return {
		get refreshRegisteredModels() { return refreshRegisteredModels; },
		set refreshRegisteredModels(value: typeof refreshRegisteredModels) { refreshRegisteredModels = value; },
		get shouldAnnounceUndetectedPlan() { return shouldAnnounceUndetectedPlan; },
		set shouldAnnounceUndetectedPlan(value: boolean) { shouldAnnounceUndetectedPlan = value; },
		detectPlanFromQuery,
	};
}

export class PlanDetection extends ServiceContext.Service<PlanDetection, PlanDetectionServices>()("claude-bridge/PlanDetection") {}
export const PlanDetectionLive = Layer.effect(PlanDetection, Effect.gen(function* () {
	const configuration = yield* Configuration;
	const diagnostics = yield* Diagnostics;
	const errors = yield* Errors;
	return createPlanDetection({ configuration, diagnostics, errors, scope: yield* Scope.Scope });
}));
