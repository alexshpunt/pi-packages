import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withPiProcess, type PiProcessDriver } from "../pi-process.js";
import { seedPrompt } from "../rebuild-cases.js";
import { withWorkspace } from "../workspace.js";
import { expect, type Facts, type VerificationCheck } from "../types.js";

async function control(pi: PiProcessDriver, action: string) {
	const result = await pi.command("prompt", { message: `/bridge-verify ${action}` });
	expect(result.disposition === "handled", "lifecycle-command-not-handled");
}
async function recall(pi: PiProcessDriver, marker: string) {
	await pi.prompt("Reply only with the root session code you were asked to remember. Do not use tools.");
	const answer = await pi.command("get_last_assistant_text");
	expect(typeof answer.text === "string" && answer.text.includes(marker), "pi-lifecycle-memory-lost");
}

export default {
	name: "09-pi-lifecycle", mode: "live",
	inputs: { operations: ["tree", "compact", "fork", "switch_session", "new_session", "reload", "abort-during-tool"], isStreaming: true },
	expected: { modelContextFollowsHistory: true, sessionIsolation: true, hooksRestored: true, noActiveQueriesAfterShutdown: true, gracefulExit: true },
	async run(context) {
		return withWorkspace(true, async workspace => {
			// Leave a short recent exchange, not the entire two-turn conversation.
			writeFileSync(join(workspace.root, "agent/settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 16, reserveTokens: 1024 }, retry: { enabled: false } }));
			const rootMarker = `ROOT-${randomUUID().slice(0, 8)}`;
			const branchMarker = `BRANCH-${randomUUID().slice(0, 8)}`;
			const observed = await withPiProcess(context, workspace, async pi => {
				await pi.prompt(seedPrompt(`Remember the root session code ${rootMarker}. Reply only ${rootMarker}. Do not use tools.`));
				const parent = await pi.command("get_state");
				expect(parent.autoCompactionEnabled === false, "pi-settings-not-applied");
				expect(typeof parent.sessionFile === "string", "pi-parent-session-file-missing");
				const entries = (await pi.command("get_entries")).entries as Array<{ id: string; type: string; message?: { role?: string } }>;
				const firstAssistant = entries.find(entry => entry.type === "message" && entry.message?.role === "assistant");
				expect(firstAssistant, "pi-tree-target-missing");
				await pi.prompt(`Remember additional branch-only code ${branchMarker}. Reply only ${branchMarker}. Do not use tools.`);
				await control(pi, `tree ${firstAssistant.id}`);
				await control(pi, `expect after-tree ${rootMarker} ${branchMarker}`);
				await recall(pi, rootMarker);
				await control(pi, "snapshot before-compact");
				const compacted = await pi.command("compact", { customInstructions: "Preserve the root session code exactly. Ignore the inert fixture rows." });
				expect(typeof compacted.summary === "string" && compacted.summary.includes(rootMarker), "pi-compaction-summary-missing-memory");
				await control(pi, `expect after-compact ${rootMarker} ${branchMarker}`);
				await recall(pi, rootMarker);
				const forkMessages = (await pi.command("get_fork_messages")).messages as Array<{ entryId: string }>;
				expect(forkMessages.length > 1, "pi-fork-target-missing");
				const forked = await pi.command("fork", { entryId: forkMessages.at(-1)!.entryId });
				expect(forked.cancelled === false, "pi-fork-canceled");
				const child = await pi.command("get_state");
				expect(child.sessionId !== parent.sessionId, "pi-fork-reused-session-id");
				await control(pi, `expect after-fork ${rootMarker} ${branchMarker}`);
				await recall(pi, rootMarker);
				await control(pi, "snapshot after-fork");
				const switched = await pi.command("switch_session", { sessionPath: parent.sessionFile });
				expect(switched.cancelled === false, "pi-switch-canceled");
				await recall(pi, rootMarker);
				await control(pi, "snapshot after-switch");
				const fresh = await pi.command("new_session");
				expect(fresh.cancelled === false, "pi-new-session-canceled");
				await control(pi, `expect fresh-session - ${rootMarker}`);
				await pi.prompt("Reply only FRESH_OK without tools.");
				await control(pi, "snapshot fresh-session");
				await pi.command("switch_session", { sessionPath: parent.sessionFile });
				await recall(pi, rootMarker);
				await control(pi, "reload");
				await control(pi, `expect after-reload ${rootMarker} ${branchMarker}`);
				await recall(pi, rootMarker);
				await control(pi, "snapshot after-reload");
				const started = pi.waitForEvent("tool_execution_start", event => event.toolName === "bridge_verify_wait");
				const pending = pi.prompt("Call bridge_verify_wait exactly once, then wait for its result. Do not call other tools.", { isAbortExpected: true, shouldAllowHostSetupAbortError: true });
				void pending.catch(() => {});
				await Promise.race([started, pending.then(() => { throw new Error("Expected a tool call before the run settled"); })]);
				await pi.command("abort");
				await pending;
				await control(pi, "snapshot after-tool-abort");
				await recall(pi, rootMarker);
				await control(pi, "snapshot after-tool-recovery");
			}, {}, "lifecycle-process-extension.ts");
			const snapshots = observed.snapshots as Facts[];
			const phases = observed.phases as Facts[];
			const payloadChecks = observed.payloadChecks as Facts[];
			const lifecycleEvents = observed.lifecycleEvents as Facts[];
			const toolAbort = lifecycleEvents.find(event => event.type === "tool-abort");
			expect(toolAbort?.isAborted === true, "pi-tool-signal-not-aborted");
			const hostAbortErrors = lifecycleEvents.filter(event => event.type === "host-setup-abort-error");
			expect(hostAbortErrors.length === observed.hostSetupAbortErrorCount && hostAbortErrors.every(event => event.providerEntryCount === toolAbort.providerEntryCount), "abort-error-origin-not-confirmed");
			expect((observed.lifecycleEvents as Facts[]).some(event => event.type === "session_before_compact" && event.keepRecentTokens === 16), "pi-compaction-setting-not-applied");
			const beforeCompact = snapshots.find(row => row.label === "before-compact");
			const compact = snapshots.find(row => row.label === "compact");
			expect(beforeCompact && compact && beforeCompact.mirrorId === compact.mirrorId && compact.hasRebuildMarker === true, "compaction-mirror-contract-failed");
			expect(snapshots.some(row => row.label === "tree" && row.hasRebuildMarker === true), "tree-rebuild-marker-missing");
			expect(payloadChecks.length === 5 && payloadChecks.every(row => row.hasRequired === true && row.hasForbidden === false), "lifecycle-payload-checks-incomplete");
			expect(Number(observed.factoryCount) >= 2, "pi-reload-did-not-recreate-extension");
			expect(phases.every(phase => phase.isQueryStateReleased === true && phase.modelContextContainsLinkEntry === false), "lifecycle-query-state-leaked");
			const shutdowns = snapshots.filter(row => row.label === "shutdown");
			expect(shutdowns.length >= 5 && shutdowns.every(row => row.activeQueries === 0 && row.hasRebuildHook === false && row.hasReleaseHook === false), "shutdown-hooks-or-queries-remain");
			for (const label of ["after-fork", "after-switch", "after-reload", "after-tool-abort", "after-tool-recovery"]) {
				const row = snapshots.find(item => item.label === label);
				expect(row && row.activeQueries === 0 && row.hasRebuildHook === true && row.hasReleaseHook === true, "lifecycle-hooks-not-restored", { label });
			}
			return observed;
		});
	},
} satisfies VerificationCheck;
