import { Context, Effect, Layer } from "effect";
import { ExtensionConfig } from "../../app/config.ts";
import { DevinLifecycle } from "./lifecycle.ts";

/**
 * Runs of the attached Pi session: budget, admission order, request leases and the stored session state.
 * A run spans many provider calls and ends at `agent_settled`, never when one response ends.
 */
export class Runs extends Context.Service<Runs, DevinLifecycle>()("pi-devin/Runs") {}

export const RunsLive = Layer.effect(Runs, Effect.flatMap(ExtensionConfig, (config) => DevinLifecycle.make(config.maxModelCalls)));
