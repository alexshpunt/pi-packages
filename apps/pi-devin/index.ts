import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { registerDevinExtension } from "./src/pi/adapters/pi/registration.ts";
import { productionEnvironment } from "./src/pi/app/environment.ts";
import { modelCallLimit } from "./src/pi/features/runs/lifecycle.ts";
import { FUSION_CHILD_ENV } from "./src/pi/features/sidekick/prompts.ts";

/** Pi's entry point. An invalid `PI_DEVIN_MAX_MODEL_CALLS` stops loading with its error. */
export default function devinExtension(pi: ExtensionAPI): void {
  const isFusionChild = process.env[FUSION_CHILD_ENV] === "1";
  const maxModelCalls = Effect.runSync(modelCallLimit(process.env.PI_DEVIN_MAX_MODEL_CALLS));
  registerDevinExtension(pi, productionEnvironment({ maxModelCalls, isFusionChild }));
}
