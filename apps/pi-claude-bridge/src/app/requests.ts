import { Context as ServiceContext, Effect, Layer } from "effect";
import type { RequestServices } from "./types.js";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { toBridgeContext } from "../adapters/pi/transcript.js";
import { InstanceRegistry } from "../adapters/pi/instance-registry.js";
import { QueryRegistry } from "../features/query/registry.js";
import { QueryService } from "../features/query/service.js";
import { Summary } from "../features/summary/service.js";
import { Configuration } from "../configuration/service.js";
import { Diagnostics } from "../diagnostics/service.js";

export class Requests extends ServiceContext.Service<Requests, RequestServices>()("claude-bridge/Requests") {}
export const RequestsLive = Layer.effect(Requests, Effect.gen(function* () {
	const instances = yield* InstanceRegistry;
	const queries = yield* QueryRegistry;
	const query = yield* QueryService;
	const summary = yield* Summary;
	const configuration = yield* Configuration;
	const diagnostics = yield* Diagnostics;
	return {
		streamClaudeAgentSdk: (model: Model<any>, input: Context, options?: SimpleStreamOptions) => Effect.gen(function* () {
			instances.enlistRebuildHook();
			queries.enlistReleaseHook();
			yield* configuration.showStartupNoticeOnce();
			const context = toBridgeContext(input);
			if (options?.cacheRetention === "none") {
				diagnostics.debug(`provider: one-off summarizer call (cacheRetention none) routed to isolated summary, msgs=${context.messages.length}`);
				return yield* summary.isolatedStreamFn(model, context, options);
			}
			return yield* query.streamClaudeAgentSdk(model, context, options);
		}),
	};
}));
