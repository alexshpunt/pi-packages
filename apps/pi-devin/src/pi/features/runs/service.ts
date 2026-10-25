import { Context, Layer } from "effect";
import { DevinLifecycle } from "./lifecycle.ts";

/**
 * Runs of the attached Pi session: admission order, request leases and the stored session state.
 * A run spans many provider calls and ends at `agent_settled`, never when one response ends.
 */
export class Runs extends Context.Service<Runs, DevinLifecycle>()("pi-devin/Runs") {}

export const RunsLive = Layer.effect(Runs, DevinLifecycle.make);
