import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { toDevinFailure, type DevinFailure } from "../../../core/errors.ts";
import type { ExtensionRuntime } from "../../app/runtime.ts";
import { FUSION_MODEL_ID } from "../../features/catalog/constants.ts";
import { ModelCatalog } from "../../features/catalog/service.ts";
import type { DevinModel, FusionChoices, FusionSelection } from "../../features/catalog/types.ts";
import { FusionSettings } from "../../features/settings/service.ts";
import { FusionPicker } from "./ui/fusion-picker.ts";

export const FUSION_COMMAND_NAME = "devin-fusion";
const USAGE = `Usage: /${FUSION_COMMAND_NAME} or /${FUSION_COMMAND_NAME} <lead model ID> <sidekick model ID>`;

const host = <A>(evaluate: () => Promise<A>) => Effect.tryPromise({ try: evaluate, catch: toDevinFailure });

const currentFusion = (models: readonly DevinModel[]) => models.find((model) => model.id === FUSION_MODEL_ID);

/** Disambiguates duplicate display names in a select list with an index, and maps the chosen label back to its value. */
function choose<T>(ctx: ExtensionCommandContext, title: string, items: readonly T[], label: (item: T) => string, isCurrent: (item: T) => boolean): Effect.Effect<T | undefined, DevinFailure> {
  const names = items.map(label);
  const labels = items.map((item, index) => {
    const name = names.filter((other) => other === names[index]).length > 1 ? `${names[index]} (${index + 1})` : names[index];
    return (isCurrent(item) ? "● " : "  ") + name;
  });
  return Effect.map(host(() => ctx.ui.select(title, labels)), (picked) => picked === undefined ? undefined : items[labels.indexOf(picked)]);
}

function pickInteractively(ctx: ExtensionCommandContext, choices: FusionChoices, current: FusionSelection | undefined): Effect.Effect<FusionSelection | undefined, DevinFailure> {
  return Effect.gen(function* () {
    const lead = yield* choose(ctx, "Devin Fusion · lead model", choices.leads, (item) => item.name, (item) => item.id === current?.leadID);
    if (!lead) return undefined;
    const groups = [...new Set(choices.sidekicks.map((item) => item.groupName))];
    const currentGroup = choices.sidekicks.find((item) => item.id === current?.sidekickID)?.groupName;
    const group = groups.length === 1 ? groups[0] : yield* choose(ctx, "Devin Fusion · sidekick model", groups, (item) => item, (item) => item === currentGroup);
    if (group === undefined) return undefined;
    const variants = choices.sidekicks.filter((item) => item.groupName === group);
    const sidekick = variants.length === 1 ? variants[0]
      : yield* choose(ctx, `Devin Fusion · sidekick variant (${group})`, variants, (item) => item.name, (item) => item.id === current?.sidekickID);
    return sidekick ? { leadID: lead.id, sidekickID: sidekick.id } : undefined;
  });
}

const fusionCommand = (args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Effect.Effect<void, DevinFailure, ModelCatalog | FusionSettings> => Effect.gen(function* () {
  const catalog = yield* ModelCatalog;
  const settings = yield* FusionSettings;
  const choices = yield* catalog.fusionChoices;
  if (!choices?.leads.length || !choices.sidekicks.length) {
    ctx.ui.notify("No Devin models are available for Fusion. Check that the model list refreshed after /login.", "warning");
    return;
  }
  const before = currentFusion(yield* catalog.models);
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let selection: FusionSelection | undefined;
  if (tokens.length) {
    const [leadID, sidekickID] = tokens;
    if (tokens.length !== 2 || !choices.leads.some((item) => item.id === leadID) || !choices.sidekicks.some((item) => item.id === sidekickID)) {
      ctx.ui.notify(`This model cannot be used for Fusion. ${USAGE}`, "error");
      return;
    }
    selection = { leadID, sidekickID };
  } else if (ctx.mode === "tui") {
    selection = yield* host(() => ctx.ui.custom<FusionSelection | undefined>((tui, theme, _keybindings, done) => new FusionPicker({
      choices, current: before?.devin.fusion, theme, requestRender: () => tui.requestRender(), done,
    })));
    if (!selection) return;
  } else if (ctx.hasUI) {
    // RPC clients cannot draw the custom screen, so they get the select dialogs.
    selection = yield* pickInteractively(ctx, choices, before?.devin.fusion);
    if (!selection) return;
  } else {
    ctx.ui.notify(before ? `Current: ${before.name}` : `No Devin Fusion pair is set. ${USAGE}`, "info");
    return;
  }
  yield* settings.write(selection);
  yield* catalog.rebuild;
  // Pi keeps model and availability snapshots. Rebuild them without network so `/model` and RPC lists update immediately.
  yield* host(() => ctx.modelRegistry.refresh({ providers: ["devin"], allowNetwork: false }));
  const after = currentFusion(yield* catalog.models);
  if (after && ctx.model?.provider === "devin" && ctx.model.id === FUSION_MODEL_ID) yield* host(() => pi.setModel(after));
  ctx.ui.notify(after ? `Saved ${after.name}. Pick Devin Fusion in /model to use it.` : "The Fusion pair was saved, but it cannot be built from the current model list.", "info");
});

/**
 * `/devin-fusion` only chooses the lead/sidekick pair. Whether Fusion is used is decided by picking Devin Fusion in `/model`.
 * If the current model is Fusion, it is re-selected with the updated model object so the thinking level range matches.
 */
export function registerFusionCommand(pi: ExtensionAPI, runtime: ExtensionRuntime): void {
  pi.registerCommand(FUSION_COMMAND_NAME, {
    description: "Choose the lead and sidekick models for Devin Fusion (saved globally)",
    handler: (args, ctx) => runtime.runPromise(fusionCommand(args, ctx, pi)),
  });
}
