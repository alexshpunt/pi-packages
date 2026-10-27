import { Context as ServiceContext, Effect, Layer } from "effect";
import type { BridgeStream, PiBridgeDependencies, PiBridgeServices } from "./types.js";
import { Requests } from "../../app/requests.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { Configuration } from "../../configuration/service.js";
import { PlanDetection } from "../../features/models/plan-detection.js";
import { SessionStore } from "../../features/session/mirror-store.js";
import { Prompts } from "../../features/prompt/service.js";
import { QueryRegistry } from "../../features/query/registry.js";
import { InstanceRegistry } from "./instance-registry.js";
import { hasRemovedToolEnabled } from "../storage/configuration.js";
import { loadConfig } from "../storage/configuration.js";
import { readDetectedPlan } from "../storage/configuration.js";
import { PROVIDER_ID } from "../../features/session/convert.js";
import { applyLongContext } from "../../features/models/policy.js";
import { forgetSessionCwd } from "./session-cwd.js";
import { rememberSessionCwd } from "./session-cwd.js";
import { rememberSummarySession } from "./session-cwd.js";
import { bindSessionLinks } from "../../features/session/continuity.js";
import { listPiToolMeta } from "./tool-meta.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// --- Constants ---

// Marks which bridge module instance owns the registered provider's stream fn.
// Full registration policy (first vs later instances, shared vs own registry):
// see the "--- Provider ---" block in activate() below.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

const REMOVED_TOOL_NOTICE_KEY = Symbol.for("claude-bridge:removedToolNoticeShown");

// --- Extension registration ---

export function registerBridge(pi: ExtensionAPI, { streamSimple, diagnostics, configuration, plans, sessions, prompts, queries, instances }: PiBridgeDependencies) {
	const config = loadConfig(process.cwd());
	diagnostics.debug("loadConfig:", JSON.stringify(config));
	configuration.providerSettings = config.provider ?? {};
	configuration.listPiToolMeta = () => listPiToolMeta(pi);
	// We need these settings to know if we're eligible for 1M context on certain models
	// Validate at the boundary: a non-array here would throw inside every
	// claudeCodeModelId call and brick the extension at activation.
	const forceTwoHundredK = Array.isArray(configuration.providerSettings.forceTwoHundredK)
		? configuration.providerSettings.forceTwoHundredK.filter((id): id is string => typeof id === "string")
		: undefined;
	// An explicit plan wins; otherwise the plan an earlier session detected from the Claude
	// Code login. The first provider query detects it again (plan-detection.ts).
	configuration.longContextSettings = {
		plan: configuration.providerSettings.plan ?? readDetectedPlan() ?? "pro",
		longContextExtraUsage: configuration.providerSettings.longContextExtraUsage ?? false,
		forceTwoHundredK,
	};
	const registeredModels = applyLongContext(configuration.MODELS, configuration.longContextSettings);
	if (registeredModels.length === 0) {
		console.error("claude-bridge: no models available from pi-ai's anthropic catalog — update Pi (requires Pi 1.0.0 or newer)");
	}

	// The plan notice waits for detection: only a login that cannot tell the plan needs it.
	plans.shouldAnnounceUndetectedPlan = !config.startupNoticeShown && config.provider?.plan === undefined;

	let releaseSessionLinks: (() => void) | undefined;
	const bindCurrentSession = (ctx: ExtensionContext) => {
		releaseSessionLinks?.();
		releaseSessionLinks = bindSessionLinks(pi, ctx, diagnostics.debug);
	};

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		diagnostics.debug(`${event}: clearing ${sessions.sharedSessions.size} shared session${sessions.sharedSessions.size === 1 ? "" : "s"}`);
		// Whole map: children never emit session_shutdown (only runtime teardown
		// and /reload do), so there is no per-entry removal to do here — the
		// top-level transition takes every mirror with it.
		sessions.clear();

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamSimple) {
			diagnostics.debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	pi.on("session_start", (event, ctx) => {
		configuration.piUI = ctx.ui;
		configuration.piMode = ctx.mode;
		if (ctx.mode === "tui" && !g[REMOVED_TOOL_NOTICE_KEY] && hasRemovedToolEnabled(ctx.cwd)) {
			ctx.ui.notify("AskClaude has been removed. Use the claude-bridge model provider instead.", "warning");
			g[REMOVED_TOOL_NOTICE_KEY] = true;
		}
		rememberSessionCwd(ctx.sessionManager.getSessionId(), ctx.cwd);
		bindCurrentSession(ctx);
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	pi.on("session_before_compact", (event, ctx) => {
		rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
	});
	pi.on("session_before_tree", (event, ctx) => {
		rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
	});
	// `--system-prompt` replaces pi's default rather than adding to it, but Claude
	// Code's preset carries its own tool and permission guidance that the bridge
	// still depends on, so both flags are forwarded as an append.
	//
	// The options (custom/append/contextFiles/skills/sections) are pi config, stable across a
	// turn; only the auto-generated tool list in the rendered prompt varies. Stash them
	// at before_agent_start so the agent_start recording below can reuse them.
	type RecordOptions = Parameters<typeof recordSystemPrompt>[2];
	let lastSystemPromptOptions: RecordOptions | undefined;
	function recordSystemPrompt(source: string, systemPrompt: string | undefined, options: {
		customPrompt?: string;
		appendSystemPrompt?: string;
		contextFiles?: { path: string; content: string }[];
		skills?: Parameters<typeof prompts.promptCaptures.record>[1]["skills"];
		sections?: Record<string, string>;
		selectedTools?: string[];
		hiddenTools?: string[];
		promptGuidelines?: string[];
		toolSnippets?: Record<string, string>;
		toolGuidelines?: Record<string, string[]>;
	} | undefined) {
		if (!systemPrompt) return;
		// Use the same declared-tool selection as Pi's prompt builder, not registration
		// provenance: SDK customTools and builtin overrides can both carry user policy.
		const visibleTools = new Set(options?.selectedTools ?? ["read", "bash", "edit", "write"]);
		for (const name of options?.hiddenTools ?? []) visibleTools.delete(name);
		const selectVisibleToolContent = <T>(content: Record<string, T> | undefined): Record<string, T> | undefined =>
			content === undefined ? undefined : Object.fromEntries(Object.entries(content).filter(([name]) => visibleTools.has(name)));
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		prompts.promptCaptures.record(systemPrompt, {
			custom: options?.customPrompt,
			append: options?.appendSystemPrompt,
			contextFiles: options?.contextFiles ?? [],
			skills: hasRead ? options?.skills ?? [] : [],
			sections: options?.sections,
			promptGuidelines: options?.promptGuidelines,
			toolSnippets: selectVisibleToolContent(options?.toolSnippets),
			toolGuidelines: selectVisibleToolContent(options?.toolGuidelines),
		}, source);
	}
	pi.on("before_agent_start", (event) => {
		lastSystemPromptOptions = event.systemPromptOptions;
		recordSystemPrompt("before_agent_start", event.systemPrompt, event.systemPromptOptions);
	});
	// The prompt the provider actually queries with is the fully-widened one: MCP tool
	// descriptions merge into the system prompt only after their servers connect, which
	// is after before_agent_start. ctx.getSystemPrompt() returns that widened prompt by
	// agent_start (verified: before_agent_start=10,988 chars vs agent_start/query=23,479).
	// A subagent embeds the widened parent prompt verbatim (pi-subagents reads
	// ctx.getSystemPrompt() at dispatch), so unless the widened prompt is a capture key
	// too, the child's turn resolves against nothing, falls to a verbatim side request,
	// and ships pi's harness — tripping the server's third-party plan-eligibility check
	// ("out of extra usage"). Recording it here, before the query, restores the match.
	//
	// agent_start also captures a handler-returned forceSystemPrompt, which
	// buildSystemPrompt renders verbatim.
	pi.on("agent_start", (_event, ctx) => {
		recordSystemPrompt("agent_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});

	// Mid-run re-renders: turn_start fires before every turn (first turn included)
	// after the turn's prompt is final: prepareNextTurnWithContext has
	// re-rendered the options (pi's section-based prompt) and any mid-run
	// setActiveToolsByName rebuild has already landed. Re-keying at each boundary
	// the prompt can change at keeps exact-match alive mid-run. The stashed options can
	// lag a mid-run tool-loadout change, which skews the hasRead skills filter until the
	// next before_agent_start — accepted: a stale skills list beats failing the turn.
	pi.on("turn_start", (_event, ctx) => {
		recordSystemPrompt("turn_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		releaseSessionLinks?.();
		releaseSessionLinks = undefined;
		forgetSessionCwd(ctx.sessionManager.getSessionId());
		queries.reportLeaks("session_shutdown");
		// Only the ending session's top-level query state, in whichever instance serves it.
		instances.sponsorReleaseSessionQueries(ctx.sessionManager.getSessionId());
		clearSession("session_shutdown");
		// Pi discards this runner now: quit, reload and session replacement each load a
		// fresh module instance. An idle instance leaves the process-wide hook registries
		// so they do not grow by one per transition. Query state still serving another
		// session keeps it enlisted until its final release; the stream entry re-enlists
		// it if called again.
		queries.markRunnerShutdown();
	});

	// Pi and summary extensions own compaction and branch summaries. Their
	// one-off calls use the isolated provider path; observe rewrites below.

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history — and, when a
	// query is parked at a tool boundary while this fires, discard that query
	// instead of resuming it (markRebuild, discardRewrittenQuery).
	//
	// Attributed to the compacting session (ctx.sessionManager belongs to the
	// session whose runner fired this), so a subagent compacting while its
	// parent sits parked on the Agent tool result discards nothing — the parent's
	// query is live and its conversation untouched. Registered by every instance
	// of this module; instances sponsoring stale marks forward them to the
	// serving instance via sponsorMarkRebuildForSession.
	pi.on("session_compact", (event, ctx) =>
		instances.sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), `session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", (_event, ctx) => {
		bindCurrentSession(ctx);
		instances.sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), "session_tree");
	});


	// --- Provider ---
	//
	// Registration policy across module instances (a subagent session can load
	// this module fresh): the FIRST instance registers unconditionally at load,
	// which is what puts claude-bridge models in the picker before any session
	// starts. Later instances decide at session_start, when ctx.modelRegistry
	// reveals who owns this session's registry:
	//
	// - Registry already has the provider (host passes the parent's registry down,
	//   e.g. pi-subagents >=0.14.3): skip. Re-registering would overwrite the
	//   parent's pinned streamSimple with this instance's fresh — empty-state —
	//   stream fn, and the parent's next tool-result delivery would route into it.
	// - Registry lacks the provider (host gives the child its own, e.g. older
	//   pi-subagents forks): register, or every claude-bridge/* dispatch in the
	//   child fails with "Model not found" (#91). Even loading the bridge via the
	//   agent's `extensions:` frontmatter didn't help there — the module loaded,
	//   hit the old skip-guard, and the child's registry stayed empty.
	//
	// A per-instance stream fn registered into a per-instance registry is
	// self-consistent: that session's traffic flows through this module state,
	// which starts clean and serves only that session.
	//
	// On session_shutdown (including /reload), clearSession() resets
	// ACTIVE_STREAM_SIMPLE_KEY so a freshly loaded module can register as first
	// again.

	const g = globalThis as Record<symbol, any>;
	const providerConfig = {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		// Cast: the Provider interface passes a TranscriptContext; the bridge takes plain
		// Context models (toBridgeContext normalizes at the stream entry points).
		streamSimple: streamSimple as any,
	};
	// Models follow the current plan settings. A detected plan can change a registered
	// context window (Opus 4.6); registering again makes Pi refresh the session's current
	// model from the registry. Only the instance that registered the provider re-registers.
	let isProviderRegistered = false;
	const registerProvider = () => {
		pi.registerProvider(PROVIDER_ID, { ...providerConfig, models: applyLongContext(configuration.MODELS, configuration.longContextSettings) });
		isProviderRegistered = true;
	};
	plans.refreshRegisteredModels = () => {
		if (isProviderRegistered) registerProvider();
	};
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamSimple;
		registerProvider();
	} else {
		// Later instance: register only if this session's registry lacks the provider.
		diagnostics.debug(`provider: deferring registration decision to session_start (module=${diagnostics.moduleInstanceId})`);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.modelRegistry.getProvider(PROVIDER_ID)) {
				diagnostics.debug(`provider: registry already has ${PROVIDER_ID}, skipping registration (module=${diagnostics.moduleInstanceId})`);
				return;
			}
			diagnostics.debug(`provider: registry lacks ${PROVIDER_ID}, registering (module=${diagnostics.moduleInstanceId})`);
			registerProvider();
		});
	}


}
export class PiBridge extends ServiceContext.Service<PiBridge, PiBridgeServices>()("claude-bridge/PiBridge") {}
export const PiBridgeLive = Layer.effect(PiBridge, Effect.gen(function* () {
	const requests = yield* Requests;
	const diagnostics = yield* Diagnostics;
	const configuration = yield* Configuration;
	const plans = yield* PlanDetection;
	const sessions = yield* SessionStore;
	const prompts = yield* Prompts;
	const queries = yield* QueryRegistry;
	const instances = yield* InstanceRegistry;
	// Preparation must finish before returning. Forked fibers inherit this sync
	// scheduler; their long-lived loops suspend on SDK I/O/Deferred, not CPU work.
	const streamSimple: BridgeStream = (model, context, options) => Effect.runSync(requests.streamClaudeAgentSdk(model, context, options));
	return {
		streamSimple,
		register: (pi) => Effect.runSync(Effect.sync(() => registerBridge(pi, { streamSimple, diagnostics, configuration, plans, sessions, prompts, queries, instances }))),
	};
}));
