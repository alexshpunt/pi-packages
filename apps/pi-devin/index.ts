import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDevinExtension } from "./src/pi/adapters/pi/registration.ts";
import { productionEnvironment } from "./src/pi/app/environment.ts";
import { FUSION_CHILD_ENV } from "./src/pi/features/sidekick/prompts.ts";

/** Pi's entry point. */
export default function devinExtension(pi: ExtensionAPI): void {
  const isFusionChild = process.env[FUSION_CHILD_ENV] === "1";
  registerDevinExtension(pi, productionEnvironment({ isFusionChild }));
}
