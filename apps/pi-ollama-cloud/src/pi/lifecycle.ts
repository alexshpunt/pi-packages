import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OllamaAccount } from "../accounts/types.ts";
import { getCloudApiKey } from "../auth/context.ts";
import { defaultCache } from "../cache/storage.ts";
import { formatUsageStatusColored } from "../usage/api.ts";
import { createUsageStatusController, type UsageStatusTarget } from "../usage/status-controller.ts";
import { createAccountRequestRunner } from "./account-requests.ts";
import { loadConfig } from "./config.ts";
import { type AccountServices, registerOllamaCommand } from "./ollama-command.ts";
import { registerWebFetchTool, registerWebSearchTool } from "./web-tools.ts";

export function registerSessionLifecycle(pi: ExtensionAPI, services: AccountServices) {
  const { router, binding } = services;
  const runWithAccount = createAccountRequestRunner(router, binding);

  // --- Web Tools Management ---

  /**
   * Ensure web tools are registered (idempotent).
   * Returns true if any tools were newly registered.
   */
  function ensureWebToolsRegistered(): boolean {
    const allTools = pi.getAllTools();
    let registered = false;
    if (!allTools.some((t) => t.name === "ollama_web_search")) {
      registerWebSearchTool(pi, defaultCache, runWithAccount);
      registered = true;
    }
    if (!allTools.some((t) => t.name === "ollama_web_fetch")) {
      registerWebFetchTool(pi, defaultCache, runWithAccount);
      registered = true;
    }
    return registered;
  }

  /**
   * Add or remove web tools from the active tools set.
   */
  function setWebToolsActive(active: boolean) {
    const currentActive = pi.getActiveTools();
    const webToolNames = ["ollama_web_search", "ollama_web_fetch"];

    if (active) {
      const missing = webToolNames.filter((n) => !currentActive.includes(n));
      if (missing.length > 0) {
        pi.setActiveTools([...currentActive, ...missing]);
      }
    } else {
      const filtered = currentActive.filter((t) => !webToolNames.includes(t));
      if (filtered.length < currentActive.length) {
        pi.setActiveTools(filtered);
      }
    }
  }

  // Config is read once per extension factory invocation (on the first
  // session_start). The factory is re-invoked on /new, /fork, /resume, and
  // /reload. Toggles changed in /ollama apply immediately and are saved to the
  // global config file, so the next factory instance starts from them unless a
  // project file or PI_OLLAMA_WEB_TOOLS overrides them.
  let configLoaded = false;
  let webToolsEnabled = false;
  let usageStatusEnabled = false;

  pi.on("session_start", async (_event, ctx) => {
    // Restore the account recorded for this session ID (resume, reload, restart); a fork has a new ID.
    binding.start(ctx.sessionManager);
    binding.setNotifier((message) => ctx.ui.notify(message, "warning"));
    if (!configLoaded) {
      configLoaded = true;
      const config = loadConfig(ctx.cwd);
      if (config.webTools !== false) {
        webToolsEnabled = true;
        ensureWebToolsRegistered();
      }
      // The status bar is opt-in: enabled only when the config explicitly sets it true.
      usageStatusEnabled = config.usageStatus === true;
    }
    // On every session start (including resume/fork/new), re-apply the
    // runtime state. Tools may have been unregistered during teardown.
    if (webToolsEnabled) {
      ensureWebToolsRegistered();
      setWebToolsActive(true);
    }
    // Start the usage status bar when ollama-cloud is the active provider.
    if (usageStatusEnabled && isOllamaCloud(ctx)) {
      startUsageStatus(ctx);
    }
  });

  // --- Usage Status Bar ---

  // Footer status showing live quota while ollama-cloud is the
  // active provider. Refreshes on a 5-minute timer; agent_end also triggers a
  // refresh but is throttled to the same cooldown. Quota comes from the
  // /api/balance endpoint. The quota-bar concept is inspired by
  // @entelligentsia/pi-ollama-cloud-usage-tracker.
  const USAGE_STATUS_KEY = "ollama-usage";
  const usageController = createUsageStatusController();

  function usageTarget(ctx: ExtensionContext): UsageStatusTarget {
    // The footer shows the session's account without assigning one; before the first
    // request it shows the Pi credential. Each refresh also updates the shared balance.
    let shown: { account: OllamaAccount; accountCount: number } | undefined;
    return {
      isTUI: ctx.mode === "tui",
      isCurrent: () => isOllamaCloud(ctx),
      resolveApiKey: async (signal) => {
        const primaryKey = await getCloudApiKey(ctx);
        const { accounts } = await router.listAccounts(primaryKey, signal);
        const account = accounts.find((item) => item.id === binding.accountId) ?? accounts[0];
        shown = account ? { account, accountCount: accounts.length } : undefined;
        return account?.apiKey;
      },
      format: (data) => {
        if (shown) void router.recordBalance(shown.account, data).catch(() => {});
        const bars = formatUsageStatusColored(ctx.ui.theme, data);
        return shown && shown.accountCount > 1 ? `${ctx.ui.theme.fg("dim", shown.account.id)} ${bars}` : bars;
      },
      setStatus: (text) => ctx.ui.setStatus(USAGE_STATUS_KEY, text),
      signal: ctx.signal,
    };
  }

  function startUsageStatus(ctx: ExtensionContext) {
    usageController.start(usageTarget(ctx));
  }

  function stopUsageStatus(ctx: ExtensionContext) {
    usageController.stop((text) => ctx.ui.setStatus(USAGE_STATUS_KEY, text));
  }

  function isOllamaCloud(ctx: ExtensionContext): boolean {
    return ctx.model?.provider === "ollama-cloud";
  }

  pi.on("model_select", async (_event, ctx) => {
    if (usageStatusEnabled && isOllamaCloud(ctx)) {
      startUsageStatus(ctx);
    } else {
      stopUsageStatus(ctx);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Throttle the after-turn refresh to the same cooldown as the timer so a
    // burst of turns never exceeds one /api/balance call per 5 minutes.
    await usageController.afterTurn(usageTarget(ctx));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopUsageStatus(ctx);
    binding.setNotifier(undefined);
  });

  // --- /ollama settings ---

  // PI_OLLAMA_WEB_TOOLS=off remains a hard kill switch: /ollama shows web tools as locked.
  registerOllamaCommand(pi, services, {
    isUsageStatusEnabled: () => usageStatusEnabled,
    setUsageStatusEnabled(enabled, ctx) {
      usageStatusEnabled = enabled;
      if (usageStatusEnabled && isOllamaCloud(ctx)) startUsageStatus(ctx);
      else stopUsageStatus(ctx);
    },
    areWebToolsEnabled: () => webToolsEnabled,
    setWebToolsEnabled(enabled) {
      webToolsEnabled = enabled;
      if (webToolsEnabled) {
        ensureWebToolsRegistered();
        setWebToolsActive(true);
      } else {
        setWebToolsActive(false);
      }
    },
  });
}
