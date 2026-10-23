import { join } from "node:path";
import { Context, Deferred, Effect, Exit, FiberSet, FileSystem, Layer, Predicate } from "effect";
import { toDevinFailure, type DevinFailure } from "../../../core/errors.ts";
import { failWith } from "../../../core/validation.ts";
import { ExtensionConfig } from "../../app/config.ts";
import { fusionOf } from "../catalog/fusion.ts";
import { ModelCatalog } from "../catalog/service.ts";
import { onDefaultScheduler } from "../default-scheduler.ts";
import { SidekickChild } from "./child.ts";
import { SidekickLauncher } from "./launcher.ts";
import { FUSION_CHILD_ENV, SIDEKICK_SYSTEM_PROMPT, SIDEKICK_TOOL_NAME } from "./prompts.ts";
import { boundReport } from "./report.ts";
import type { BoundedReport, Handoff, HandoffReport, HandoffResult, SidekickDetails, SidekickHostShape, SidekickLaunch, SidekicksShape } from "./types.ts";

/** What the sidekick needs from the lead Pi. Provided by the Pi adapter. */
export class SidekickHost extends Context.Service<SidekickHost, SidekickHostShape>()("pi-devin/SidekickHost") {}

/**
 * The Fusion sidekick: one child Pi per lead session, started on the first handoff and kept for the rest of the session.
 * Owns the children, which call owns each report, and the fibers that deliver background reports.
 */
export class Sidekicks extends Context.Service<Sidekicks, SidekicksShape>()("pi-devin/Sidekicks") {}

const launchKey = (launch: SidekickLaunch) => JSON.stringify([launch.cwd, launch.modelID, launch.thinking, launch.sessionFile, launch.tools]);
const shortID = (id: string) => id.slice(0, 8);
const reportPath = (fullReportPath: string | undefined) => fullReportPath ? { fullReportPath } : {};
const nextMicrotask = Effect.promise(() => Promise.resolve());
/** Stops before work starts when the call was already cancelled, as `signal.throwIfAborted()` does. */
const checkAborted = (signal: AbortSignal | undefined): Effect.Effect<void, DevinFailure> => signal?.aborted ? Effect.fail(toDevinFailure(signal.reason)) : Effect.void;

interface ReportDelivery {
  owner: "background" | "blocking" | "delivered";
  scheduled: boolean;
}

type WaitOutcome = "done" | "aborted" | "interrupted";

export const SidekicksLive = Layer.effect(Sidekicks, Effect.gen(function* () {
  const host = yield* SidekickHost;
  const launcher = yield* SidekickLauncher;
  const catalog = yield* ModelCatalog;
  const config = yield* ExtensionConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const fibers = yield* FiberSet.make<void, never>();
  const runInFibers = yield* FiberSet.runtime(fibers)<never>();
  const children = new Map<string, SidekickChild>();
  // Steers share the same report; completed handoffs must not be retained by delivery bookkeeping.
  const deliveries = new WeakMap<Deferred.Deferred<HandoffReport>, ReportDelivery>();
  const waits = new Set<() => void>();
  // The tool runs sequentially, so at most one blocking call shows progress at a time.
  let progressListener: (() => void) | undefined;

  /** Bound and preserve the complete report, including status, errors and any background delivery heading. */
  const reportText = (report: HandoffReport, heading = ""): Effect.Effect<BoundedReport> => {
    const body = report.text.trim();
    const reason = report.error ?? (report.status === "aborted" ? "cancelled." : "failed.");
    const text = report.status === "completed" ? body || "(The sidekick finished without a report.)"
      : [`The sidekick task ${report.status === "aborted" ? "stopped" : "failed"}: ${reason}`, body].filter(Boolean).join("\n\n");
    return boundReport(heading + text).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
  };

  const deliverLater = (handoff: Handoff, child: SidekickChild, delivery: ReportDelivery) => Effect.suspend(() => {
    if (delivery.scheduled || delivery.owner === "delivered") return Effect.void;
    delivery.scheduled = true;
    // A blocking call owns the report unless user input moves it back to the background.
    const canDeliver = () => delivery.owner === "background" && [...children.values()].includes(child);
    return Effect.asVoid(FiberSet.run(fibers, Effect.gen(function* () {
      const report = yield* Deferred.await(handoff.done);
      if (report.status === "aborted" || !canDeliver()) return;
      const { text, fullReportPath } = yield* reportText(report, `Sidekick report for background handoff ${shortID(report.id)}:\n\n`);
      if (!canDeliver()) return;
      delivery.owner = "delivered";
      yield* host.deliverReport({
        content: text,
        details: { sidekickModel: child.launch.modelID, handoffId: report.id, status: report.status, toolCalls: report.toolCalls, durationMs: report.durationMs, isSteer: false,
          ...reportPath(fullReportPath) },
      });
    }).pipe(Effect.ensuring(Effect.sync(() => { delivery.scheduled = false; }))), { startImmediately: true }));
  });

  const closeAll = (entries: readonly [string, SidekickChild][]) => Effect.forEach(entries, ([id, child]) => Effect.andThen(child.close, Effect.sync(() => {
    children.delete(id);
  })), { discard: true });

  return {
    handoff: (request) => Effect.gen(function* () {
      const { signal } = request;
      yield* checkAborted(signal);
      const fusion = fusionOf(yield* catalog.models, request.model);
      if (!fusion) return yield* failWith("The sidekick is only available with the Devin Fusion model.");
      const input = Predicate.isObject(request.params) ? request.params as { message?: unknown; block?: unknown } : undefined;
      const message = Predicate.isString(input?.message) ? input.message.trim() : "";
      if (!message) return yield* failWith("A message for the sidekick is required.");
      // The lead list hides exact UIDs covered by groups, so the level comes from the Fusion candidates.
      const sidekickChoice = (yield* catalog.fusionChoices)?.sidekicks.find((item) => item.id === fusion.sidekickID);
      if (!sidekickChoice) return yield* failWith("The sidekick model is not in the current Devin model list. Refresh the model list.");
      const { sessionId } = request;
      const launch: SidekickLaunch = {
        cwd: request.cwd, modelID: fusion.sidekickID, thinking: sidekickChoice.level,
        sessionFile: request.isSessionSaved ? join(config.agentDir(), "pi-devin", "sidekick", `${sessionId}.jsonl`) : undefined,
        tools: (yield* host.activeTools).filter((name) => name !== SIDEKICK_TOOL_NAME),
        systemPrompt: SIDEKICK_SYSTEM_PROMPT,
      };
      let child = children.get(sessionId);
      // When the pair or tools change, only an idle process is restarted. Context continues through the same session file.
      if (child && !child.isBusy() && launchKey(child.launch) !== launchKey(launch)) { yield* child.close; child = undefined; }
      if (!child) {
        child = new SidekickChild(launch, {
          launcher, childEnv: { [FUSION_CHILD_ENV]: "1" }, onProgress: () => progressListener?.(),
          fork: (effect) => { runInFibers(onDefaultScheduler(effect)); },
        });
        children.set(sessionId, child);
      }
      const active = child;
      yield* checkAborted(signal);
      const handoff = yield* active.handoff(message);
      let delivery = deliveries.get(handoff.done);
      if (!delivery) {
        delivery = { owner: "background", scheduled: false };
        deliveries.set(handoff.done, delivery);
      }
      const owned = delivery;
      const details = (status: SidekickDetails["status"], report?: HandoffReport): SidekickDetails => ({
        sidekickModel: launch.modelID, handoffId: handoff.id, status, toolCalls: report?.toolCalls ?? active.progress()?.toolCalls ?? 0,
        ...(report ? { durationMs: report.durationMs } : {}), isSteer: handoff.isSteer,
      });
      const backgroundResult = (reason: string) => Effect.as(deliverLater(handoff, active, owned), {
        content: [{ type: "text" as const, text: `${reason} The report will arrive as a message. (handoff ${shortID(handoff.id)})` }], details: details("background"),
      } satisfies HandoffResult);
      if (input?.block === false) {
        return yield* backgroundResult(handoff.isSteer ? "Added instructions to the running sidekick task." : "The sidekick started working in the background.");
      }
      owned.owner = "blocking";
      // The first event decides the outcome. The report is observed one microtask after it settles, as a promise continuation
      // would, so user input in the same tick still moves the handoff to the background.
      const decided = Deferred.makeUnsafe<WaitOutcome>();
      const decide = (outcome: WaitOutcome) => () => { Deferred.doneUnsafe(decided, Exit.succeed(outcome)); };
      const interrupt = decide("interrupted"), abort = decide("aborted");
      const listen = Effect.gen(function* () {
        waits.add(interrupt);
        signal?.addEventListener("abort", abort, { once: true });
        progressListener = () => {
          const progress = active.progress();
          if (progress) request.onProgress?.(`sidekick: ${progress.toolCalls} tool calls${progress.recentTools.length ? ` · ${progress.recentTools.join(", ")}` : ""}`, details("running"));
        };
        if (signal?.aborted) abort();
        yield* FiberSet.run(fibers, Deferred.await(handoff.done).pipe(Effect.andThen(nextMicrotask), Effect.andThen(Effect.sync(decide("done")))), { startImmediately: true });
      });
      const stopListening = Effect.sync(() => {
        progressListener = undefined;
        waits.delete(interrupt);
        signal?.removeEventListener("abort", abort);
      });
      const outcome = yield* Effect.acquireUseRelease(listen, () => Deferred.await(decided), () => stopListening);
      if (outcome === "interrupted") {
        owned.owner = "background";
        return yield* backgroundResult("A user message arrived, so the sidekick task moved to the background.");
      }
      owned.owner = "delivered";
      if (outcome === "aborted") {
        yield* active.abort;
        return yield* failWith("Cancelled the sidekick task.");
      }
      const report = yield* Deferred.await(handoff.done);
      const { text, fullReportPath } = yield* reportText(report);
      if (report.status !== "completed") return yield* failWith(text);
      return { content: [{ type: "text" as const, text }], details: { ...details(report.status, report), ...reportPath(fullReportPath) } } satisfies HandoffResult;
    }),
    userInput: (source) => Effect.sync(() => {
      if (source === "extension") return;
      for (const interrupt of [...waits]) interrupt();
    }),
    sessionStarted: (sessionId) => Effect.suspend(() => closeAll([...children].filter(([id]) => id !== sessionId))),
    reset: Effect.suspend(() => closeAll([...children])),
  } satisfies SidekicksShape;
}));
