import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { AnalyticsReader } from "../analytics.js";
import { excerptDiffText } from "../excerpt.js";
import type { MaskPreview } from "../masking-session.js";
import { errorText, notify } from "../notify.js";
import {
  type CustomTarget,
  parseSettingsDocument,
  readSettingsTextEffect,
  type SettingsDocument,
  type SettingsScope,
} from "../settings.js";
import { onOff, type RedactStatus, statusLines } from "../status.js";
import { AnalyticsPanel } from "../ui/analytics-panel.js";
import { CustomPanel } from "../ui/custom-panel.js";
import { RedactPanel } from "../ui/redact-panel.js";

export const REDACT_COMMAND = "redact";
export const CUSTOM_COMMAND = "redact-custom";
export const ANALYTICS_COMMAND = "redact-analytics";

/** What the commands need from the running extension. */
export interface RedactController {
  status(ctx: ExtensionContext): RedactStatus;
  setSessionEnabled(ctx: ExtensionContext, isEnabled: boolean): void;
  setGlobalEnabled(ctx: ExtensionContext, isEnabled: boolean): Promise<void>;
  customTargets(ctx: ExtensionContext): Promise<readonly CustomTarget[]>;
  saveSettings(ctx: ExtensionContext, scope: SettingsScope, document: SettingsDocument): Promise<void>;
  preview(text: string): MaskPreview;
  analytics(): AnalyticsReader;
}

/** RPC clients show notifications and dialogs but not terminal components. */
const hasTerminal = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;

function warnAboutArguments(ctx: ExtensionContext, command: string, args: string): void {
  if (args.trim()) notify(ctx, `/${command} takes no arguments; it opens its page.`, "warning");
}

async function openRedact(ctx: ExtensionCommandContext, controller: RedactController): Promise<void> {
  if (hasTerminal(ctx)) {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new RedactPanel({
          theme,
          getStatus: () => controller.status(ctx),
          setSessionEnabled: (isEnabled) => controller.setSessionEnabled(ctx, isEnabled),
          setGlobalEnabled: (isEnabled) => controller.setGlobalEnabled(ctx, isEnabled),
          requestRender: () => tui.requestRender(),
          onClose: () => done(),
        }),
    );
    return;
  }
  notify(ctx, statusLines(controller.status(ctx)).join("\n"), "info");
  if (!ctx.hasUI) return;
  for (;;) {
    const status = controller.status(ctx);
    const choices = [
      `This session: ${onOff(status.isEnabled)} (turn ${onOff(!status.isEnabled)})`,
      `Global default: ${onOff(status.isEnabledByDefault)} (turn ${onOff(!status.isEnabledByDefault)})`,
      "Close",
    ];
    const index = choices.indexOf((await ctx.ui.select("Redact", choices)) ?? "");
    try {
      if (index === 0) controller.setSessionEnabled(ctx, !status.isEnabled);
      else if (index === 1) await controller.setGlobalEnabled(ctx, !status.isEnabledByDefault);
      else return;
    } catch (error) {
      notify(ctx, errorText(error), "error");
    }
  }
}

/** Without a terminal, edit the file's JSON in Pi's editor dialog and save it after validation. */
async function editSettingsText(
  ctx: ExtensionCommandContext,
  controller: RedactController,
  target: CustomTarget,
): Promise<void> {
  let text = await Effect.runPromise(readSettingsTextEffect(target.path));
  for (;;) {
    const edited = await ctx.ui.editor(`pi-redact settings: ${target.path}`, text);
    if (edited === undefined) return;
    text = edited;
    let parsed: unknown;
    try {
      parsed = JSON.parse(edited);
    } catch {
      notify(ctx, "The text is not valid JSON; nothing was saved.", "error");
      continue;
    }
    const { document, problems } = parseSettingsDocument(parsed, target.scope);
    if (!document) {
      notify(ctx, `Nothing was saved: ${problems.join("; ")}`, "error");
      continue;
    }
    try {
      await controller.saveSettings(ctx, target.scope, document);
      notify(ctx, `Saved ${target.path}.`, "info");
      return;
    } catch (error) {
      notify(ctx, errorText(error), "error");
    }
  }
}

async function openCustom(ctx: ExtensionCommandContext, controller: RedactController): Promise<void> {
  const targets = await controller.customTargets(ctx);
  if (hasTerminal(ctx)) {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new CustomPanel({
          theme,
          targets,
          actions: {
            load: () => controller.customTargets(ctx),
            save: (scope, document) => controller.saveSettings(ctx, scope, document),
            preview: (text) => controller.preview(text),
          },
          requestRender: () => tui.requestRender(),
          onClose: () => done(),
        }),
    );
    return;
  }
  const editable = targets.filter((target) => target.unavailableReason === undefined);
  if (!ctx.hasUI) {
    const lines = targets.map(
      (target) => `${target.scope}: ${target.path}${target.unavailableReason ? ` (${target.unavailableReason})` : ""}`,
    );
    notify(ctx, ["pi-redact settings files:", ...lines, "Edit them as JSON, then run /reload."].join("\n"), "info");
    return;
  }
  let target: CustomTarget | undefined = editable[0];
  if (editable.length > 1) {
    const choice = await ctx.ui.select(
      "Edit which pi-redact settings file?",
      editable.map((entry) => `${entry.scope}: ${entry.path}`),
    );
    target = editable.find((entry) => `${entry.scope}: ${entry.path}` === choice);
  }
  if (target) await editSettingsText(ctx, controller, target);
}

/** Without a terminal, list the latest records as plain diffs. */
function analyticsText(ctx: ExtensionContext, reader: AnalyticsReader): string {
  const scope = { sessionId: ctx.sessionManager.getSessionId() };
  const summary = reader.summarize(scope);
  if (summary.records === 0) return "pi-redact has not masked anything in this session yet.";
  const lines = [
    `pi-redact masked ${summary.records} texts in this session (${summary.changedLines} lines). ` +
      `Rules: ${summary.rules.map(([ruleId, count]) => `${ruleId} ${count}`).join(", ")}`,
  ];
  for (const record of reader.list(scope, 5)) {
    const stored = reader.get(record.id);
    lines.push("", `${new Date(record.recordedAtMs).toISOString()} ${record.source}: ${record.label}`);
    if (stored?.excerpt) lines.push(excerptDiffText(stored.excerpt));
  }
  return lines.join("\n");
}

async function openAnalytics(ctx: ExtensionCommandContext, controller: RedactController): Promise<void> {
  const reader = controller.analytics();
  if (hasTerminal(ctx)) {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new AnalyticsPanel({
          theme,
          sessionId: ctx.sessionManager.getSessionId(),
          reader,
          rows: () => tui.terminal.rows,
          requestRender: () => tui.requestRender(),
          onClose: () => done(),
        }),
    );
    return;
  }
  try {
    notify(ctx, analyticsText(ctx, reader), "info");
  } catch (error) {
    notify(ctx, `The analytics file could not be read: ${errorText(error)}`, "error");
  }
}

export function registerRedactCommands(pi: ExtensionAPI, controller: RedactController): void {
  pi.registerCommand(REDACT_COMMAND, {
    description: "Show pi-redact's state and turn masking on or off for this session or by default",
    handler: async (args, ctx) => {
      warnAboutArguments(ctx, REDACT_COMMAND, args);
      await openRedact(ctx, controller);
    },
  });
  pi.registerCommand(CUSTOM_COMMAND, {
    description: "Edit pi-redact's rules, personal information, field names, patterns, and exceptions",
    handler: async (args, ctx) => {
      warnAboutArguments(ctx, CUSTOM_COMMAND, args);
      await openCustom(ctx, controller);
    },
  });
  pi.registerCommand(ANALYTICS_COMMAND, {
    description: "Show what pi-redact masked, before and after",
    handler: async (args, ctx) => {
      warnAboutArguments(ctx, ANALYTICS_COMMAND, args);
      await openAnalytics(ctx, controller);
    },
  });
}
