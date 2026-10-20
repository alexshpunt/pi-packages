import { planFromSubscriptionType, recordDetectedPlan } from "../config.js";
import type { BridgeRuntime } from "../runtime.js";

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
	readonly detectPlanFromQuery: (sdkQuery: AccountInfoSource) => void;
}

const UNDETECTED_PLAN_NOTICE =
	'Could not tell your Claude plan from the Claude Code login. On Max or Team Premium, set provider.plan to "max" to use Opus 4.6 with 1M context.';

export function createPlanDetection(runtime: Pick<BridgeRuntime, "debug" | "errorMessage" | "longContextSettings" | "pendingNotices" | "providerSettings">): PlanDetectionServices {
	let refreshRegisteredModels: (() => void) | null = null;
	let shouldAnnounceUndetectedPlan = false;
	let isDetectionStarted = false;

	function announceUndetectedPlan(): void {
		if (!shouldAnnounceUndetectedPlan) return;
		shouldAnnounceUndetectedPlan = false;
		// Shown by the next provider call's showStartupNoticeOnce, like the other notices.
		runtime.pendingNotices.push(UNDETECTED_PLAN_NOTICE);
	}

	async function detectPlan(sdkQuery: Required<AccountInfoSource>): Promise<void> {
		let subscriptionType: string | undefined;
		try {
			subscriptionType = (await sdkQuery.accountInfo()).subscriptionType;
		} catch (error) {
			// A query closed before answering (abort, failed start) says nothing about the plan.
			isDetectionStarted = false;
			runtime.debug(`plan: accountInfo failed, retrying on the next query: ${runtime.errorMessage(error)}`);
			return;
		}
		const plan = planFromSubscriptionType(subscriptionType);
		runtime.debug(`plan: subscriptionType=${subscriptionType ?? "(absent)"} -> ${plan ?? "undetected"}`);
		if (!plan) {
			announceUndetectedPlan();
			return;
		}
		shouldAnnounceUndetectedPlan = false;
		try {
			recordDetectedPlan(plan);
		} catch (error) {
			runtime.debug(`plan: could not record ${plan}: ${runtime.errorMessage(error)}`);
		}
		if (plan === runtime.longContextSettings.plan) return;
		runtime.longContextSettings = { ...runtime.longContextSettings, plan };
		try {
			refreshRegisteredModels?.();
		} catch (error) {
			runtime.debug(`plan: could not register models for ${plan}: ${runtime.errorMessage(error)}`);
		}
	}

	/** Read the plan once per runtime from the first provider query. The query is already
	 *  running, so accountInfo() adds no model request. An explicit provider.plan wins and
	 *  skips detection. */
	function detectPlanFromQuery(sdkQuery: AccountInfoSource): void {
		if (isDetectionStarted || runtime.providerSettings.plan !== undefined) return;
		const { accountInfo } = sdkQuery;
		if (typeof accountInfo !== "function") return;
		isDetectionStarted = true;
		void detectPlan({ accountInfo: () => accountInfo.call(sdkQuery) });
	}

	return {
		get refreshRegisteredModels() { return refreshRegisteredModels; },
		set refreshRegisteredModels(value: typeof refreshRegisteredModels) { refreshRegisteredModels = value; },
		get shouldAnnounceUndetectedPlan() { return shouldAnnounceUndetectedPlan; },
		set shouldAnnounceUndetectedPlan(value: boolean) { shouldAnnounceUndetectedPlan = value; },
		detectPlanFromQuery,
	};
}
