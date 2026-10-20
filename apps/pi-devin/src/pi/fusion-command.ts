import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FUSION_MODEL_ID, type DevinModel, type FusionChoices, type FusionSelection } from "./models.ts";
import { FusionPicker } from "./fusion-picker.ts";
import type { FusionSettings } from "./fusion-settings.ts";
import type { DevinProvider } from "./provider.ts";

export const FUSION_COMMAND_NAME = "devin-fusion";
const USAGE = `Usage: /${FUSION_COMMAND_NAME} or /${FUSION_COMMAND_NAME} <lead model ID> <sidekick model ID>`;

function currentFusion(provider: DevinProvider): DevinModel | undefined {
  return (provider.getModels() as readonly DevinModel[]).find((model) => model.id === FUSION_MODEL_ID);
}

/** Disambiguates duplicate display names in a select list with an index, and maps the chosen label back to its value. */
async function choose<T>(ctx: ExtensionCommandContext, title: string, items: readonly T[], label: (item: T) => string, isCurrent: (item: T) => boolean) {
  const names = items.map(label);
  const labels = items.map((item, index) => {
    const name = names.filter((other) => other === names[index]).length > 1 ? `${names[index]} (${index + 1})` : names[index];
    return (isCurrent(item) ? "● " : "  ") + name;
  });
  const picked = await ctx.ui.select(title, labels);
  return picked === undefined ? undefined : items[labels.indexOf(picked)];
}

async function pickInteractively(ctx: ExtensionCommandContext, choices: FusionChoices, current: FusionSelection | undefined): Promise<FusionSelection | undefined> {
  const lead = await choose(ctx, "Devin Fusion · lead model", choices.leads, (item) => item.name, (item) => item.id === current?.leadID);
  if (!lead) return undefined;
  const groups = [...new Set(choices.sidekicks.map((item) => item.groupName))];
  const currentGroup = choices.sidekicks.find((item) => item.id === current?.sidekickID)?.groupName;
  const group = groups.length === 1 ? groups[0] : await choose(ctx, "Devin Fusion · sidekick model", groups, (item) => item, (item) => item === currentGroup);
  if (group === undefined) return undefined;
  const variants = choices.sidekicks.filter((item) => item.groupName === group);
  const sidekick = variants.length === 1 ? variants[0]
    : await choose(ctx, `Devin Fusion · sidekick variant (${group})`, variants, (item) => item.name, (item) => item.id === current?.sidekickID);
  return sidekick ? { leadID: lead.id, sidekickID: sidekick.id } : undefined;
}

/**
 * `/devin-fusion` only chooses the lead/sidekick pair. Whether Fusion is used is decided by picking Devin Fusion in `/model`.
 * If the current model is Fusion, it is re-selected with the updated model object so the thinking level range matches.
 */
export function registerFusionCommand(pi: ExtensionAPI, provider: DevinProvider, settings: FusionSettings): void {
  pi.registerCommand(FUSION_COMMAND_NAME, {
    description: "Choose the lead and sidekick models for Devin Fusion (saved globally)",
    handler: async (args, ctx) => {
      const choices = provider.getFusionChoices();
      if (!choices?.leads.length || !choices.sidekicks.length) {
        ctx.ui.notify("No Devin models are available for Fusion. Check that the model list refreshed after /login.", "warning");
        return;
      }
      const before = currentFusion(provider);
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
        selection = await ctx.ui.custom<FusionSelection | undefined>((tui, theme, _keybindings, done) => new FusionPicker({
          choices, current: before?.devin.fusion, theme, requestRender: () => tui.requestRender(), done,
        }));
        if (!selection) return;
      } else if (ctx.hasUI) {
        // RPC clients cannot draw the custom screen, so they get the select dialogs.
        selection = await pickInteractively(ctx, choices, before?.devin.fusion);
        if (!selection) return;
      } else {
        ctx.ui.notify(before ? `Current: ${before.name}` : `No Devin Fusion pair is set. ${USAGE}`, "info");
        return;
      }
      settings.write(selection);
      provider.rebuildModels();
      // Pi keeps model and availability snapshots. Rebuild them without network so `/model` and RPC lists update immediately.
      await ctx.modelRegistry.refresh({ providers: ["devin"], allowNetwork: false });
      const after = currentFusion(provider);
      if (after && ctx.model?.provider === "devin" && ctx.model.id === FUSION_MODEL_ID) await pi.setModel(after);
      ctx.ui.notify(after ? `Saved ${after.name}. Pick Devin Fusion in /model to use it.` : "The Fusion pair was saved, but it cannot be built from the current model list.", "info");
    },
  });
}
