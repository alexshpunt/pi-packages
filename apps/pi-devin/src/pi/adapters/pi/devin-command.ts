import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { toDevinFailure, type DevinError, type DevinFailure } from "../../../core/errors.ts";
import { ExtensionConfig } from "../../app/config.ts";
import type { ExtensionRuntime } from "../../app/runtime.ts";
import { ModelCatalog } from "../../features/catalog/service.ts";
import { DisplaySettings } from "../../features/settings/service.ts";
import type { DevinPreferences } from "../../features/settings/types.ts";
import { sessionUsage, usageReport } from "../../features/usage/report.ts";
import { DevinPanel, PREFERENCE_ITEMS } from "./ui/devin-panel.ts";
import { UsageStatus } from "./usage-status.ts";

export const DEVIN_COMMAND_NAME = "devin";
const USAGE = "Usage: /devin, /devin recommended on|off, /devin status on|off";
const ARGUMENT_KEYS: Readonly<Record<string, keyof DevinPreferences>> = { recommended: "recommendedOnly", status: "showUsageStatus" };

const onOff = (value: boolean) => value ? "on" : "off";

/** Saves the settings and applies them: a changed filter rebuilds Pi's model snapshots without network. Only a failed save fails. */
const applyPreferences = (ctx: ExtensionCommandContext, next: DevinPreferences): Effect.Effect<void, DevinError, DisplaySettings | ModelCatalog | UsageStatus> => Effect.gen(function* () {
  const settings = yield* DisplaySettings;
  const catalog = yield* ModelCatalog;
  const previous = yield* settings.read;
  // A list refresh failure after saving is reported as a warning so the screen and the saved value stay in sync.
  yield* settings.write(next);
  if (previous.recommendedOnly !== next.recommendedOnly) {
    yield* catalog.rebuild;
    // Pi keeps model and availability snapshots. Rebuild them without network so `/model` and RPC lists update immediately.
    yield* Effect.tryPromise({ try: () => ctx.modelRegistry.refresh({ providers: ["devin"], allowNetwork: false }), catch: toDevinFailure }).pipe(
      Effect.catch((error) => Effect.sync(() => ctx.ui.notify(`Settings were saved, but the model list could not be rebuilt: ${error.message}`, "warning"))),
    );
    const model = ctx.model;
    if (model?.provider === "devin" && !(yield* catalog.models).some((item) => item.id === model.id)) {
      ctx.ui.notify(`The current model ${model.name} is now hidden from the list but stays in use for this session. To restore it when reopening the session, pick a model from the list.`, "warning");
    }
  }
  yield* (yield* UsageStatus).update(ctx);
});

const devinCommand = (args: string, ctx: ExtensionCommandContext, runtime: ExtensionRuntime): Effect.Effect<void, DevinFailure, DisplaySettings | ModelCatalog | UsageStatus | ExtensionConfig> => Effect.gen(function* () {
  const settings = yield* DisplaySettings;
  const status = yield* UsageStatus;
  const { now } = yield* ExtensionConfig;
  const report = () => runtime.runSync(Effect.gen(function* () {
    return usageReport(yield* status.accountUsage, sessionUsage(ctx.sessionManager.getBranch()), now());
  }));
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length) {
    const key = ARGUMENT_KEYS[tokens[0]];
    if (tokens.length !== 2 || !key || (tokens[1] !== "on" && tokens[1] !== "off")) {
      ctx.ui.notify(`Unknown argument. ${USAGE}`, "error");
      return;
    }
    const value = tokens[1] === "on";
    yield* applyPreferences(ctx, { ...(yield* settings.read), [key]: value });
    ctx.ui.notify(`${PREFERENCE_ITEMS.find((item) => item.key === key)!.label}: ${onOff(value)} (saved globally)`, "info");
    return;
  }
  if (ctx.mode === "tui") {
    const preferences = yield* settings.read;
    const services = yield* Effect.context<DisplaySettings | ModelCatalog | UsageStatus>();
    yield* Effect.tryPromise({ try: () => ctx.ui.custom<void>((tui, theme, _keybindings, done) => new DevinPanel({
      theme, report, preferences, onChange: (next) => applyPreferences(ctx, next).pipe(Effect.provideContext(services)),
      requestRender: () => tui.requestRender(), done: () => done(),
    })), catch: toDevinFailure });
    return;
  }
  const preferences = yield* settings.read;
  const summary = PREFERENCE_ITEMS.map((item) => `${item.label} ${onOff(preferences[item.key])}`).join(" · ");
  ctx.ui.notify([...report().map((line) => line.text), `Settings: ${summary}`, USAGE].join("\n"), "info");
});

/**
 * `/devin` shows usage details and display settings. Settings are saved globally and applied immediately.
 * The TUI gets a dedicated screen; other modes use arguments and notifications.
 */
export function registerDevinCommand(pi: ExtensionAPI, runtime: ExtensionRuntime): void {
  pi.registerCommand(DEVIN_COMMAND_NAME, {
    description: "Show Devin usage and change display settings (recommended models only, usage in the status line); saved globally",
    handler: (args, ctx) => runtime.runPromise(devinCommand(args, ctx, runtime)),
  });
}
