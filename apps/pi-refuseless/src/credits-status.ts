import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatUsd, readCredits } from "./credits.ts";
import { REFUSELESS_PROVIDER_ID } from "./models.ts";
import { readSettings, saveSettings } from "./settings.ts";

export const CREDITS_STATUS_KEY = "refuseless-credits";

/** The status line switch that `/pi-refuseless` shows. */
export interface CreditsStatus {
  isEnabled(): boolean;
  /**
   * Applies `enabled` at once and saves it in the settings file. Returns why saving failed; the choice then lasts
   * until Pi restarts or reloads.
   */
  setEnabled(enabled: boolean, ctx: ExtensionContext): string | undefined;
}

/**
 * Shows the available Refuseless credits in interactive Pi's status line while a Refuseless model is active. The
 * balance is read when a session starts, when a model is picked, after each reply and when the switch is turned on.
 * A failed read clears the entry, and a read that a newer read, another model or the end of the session overtook
 * is dropped. On unless the settings file turns it off.
 */
export function registerCreditsStatus(pi: ExtensionAPI): CreditsStatus {
  let enabled: boolean | undefined;
  let pending: AbortController | undefined;
  const isEnabled = () => (enabled ??= readSettings().creditsStatus !== false);

  function clear(ctx: ExtensionContext) {
    pending?.abort();
    pending = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(CREDITS_STATUS_KEY, undefined);
  }

  async function refresh(ctx: ExtensionContext, model: Model<any> | undefined = ctx.model) {
    if (ctx.mode !== "tui" || model?.provider !== REFUSELESS_PROVIDER_ID || !isEnabled()) return clear(ctx);
    pending?.abort();
    const request = new AbortController();
    pending = request;
    const text = await readCredits(ctx, request.signal).then(
      (credits) => credits && `Refuseless ${formatUsd(credits.available)}`,
      () => undefined,
    );
    if (pending !== request) return;
    pending = undefined;
    ctx.ui.setStatus(CREDITS_STATUS_KEY, text);
  }

  pi.on("session_start", (_event, ctx) => void refresh(ctx));
  pi.on("model_select", (event, ctx) => void refresh(ctx, event.model));
  pi.on("agent_end", (_event, ctx) => void refresh(ctx));
  pi.on("session_shutdown", (_event, ctx) => clear(ctx));

  return {
    isEnabled,
    setEnabled(value, ctx) {
      enabled = value;
      void refresh(ctx);
      try {
        saveSettings({ creditsStatus: value });
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}
