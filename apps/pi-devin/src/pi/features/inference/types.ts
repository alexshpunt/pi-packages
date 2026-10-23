import type { AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Effect } from "effect";
import type { DevinAPI } from "../catalog/types.ts";

export interface InferenceShape {
  /**
   * Returns Pi's event stream for one Devin request. Runs synchronously up to the first wait: the stream carries its
   * start event, and the request already holds its sign-in generation and provider lifetime. The request runs on in a fiber the service owns.
   */
  readonly start: (model: Model<DevinAPI>, context: TranscriptContext, options?: SimpleStreamOptions) => Effect.Effect<AssistantMessageEventStream>;
}
