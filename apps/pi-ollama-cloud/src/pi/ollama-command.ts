import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { validateAccountIdFormat } from "../accounts/credentials.ts";
import { classifyThrownError } from "../accounts/failure.ts";
import { accountUnavailableReason } from "../accounts/policy.ts";
import { accountOverview, formatAccountsReport, VISIBLE_KEY_PREFIX_LENGTH } from "../accounts/report.ts";
import type { AccountRouter } from "../accounts/router.ts";
import type { SessionAccountBinding } from "../accounts/session.ts";
import { DEFAULT_ACCOUNT_ID } from "../accounts/types.ts";
import { getCloudApiKey } from "../auth/context.ts";
import {
  type AccountAction,
  OllamaSettingsPanel,
  type PanelMessage,
  type PanelUsageEntry,
  type PanelUsageReport,
  type PanelView,
  type SettingsPanelActions,
} from "../render/settings-panel.ts";
import { OllamaHttpError } from "../shared/http.ts";
import { fetchUsage, fetchUsageStats, formatUsageSummary, type UsageStats } from "../usage/api.ts";
import { resolveToggleArgument } from "../usage/status.ts";
import {
  globalConfigPath,
  type OllamaCloudConfig,
  readConfigLayers,
  resolveWebToolsEnv,
  saveGlobalConfig,
} from "./config.ts";
import { showCloudUsage } from "./usage-command.ts";

export interface AccountServices {
  router: AccountRouter;
  binding: SessionAccountBinding;
}

/** Runtime switches owned by the session lifecycle. */
export interface SettingsControls {
  isUsageStatusEnabled(): boolean;
  setUsageStatusEnabled(enabled: boolean, ctx: ExtensionContext): void;
  areWebToolsEnabled(): boolean;
  setWebToolsEnabled(enabled: boolean): void;
}

const SUBCOMMANDS = ["usage", "status", "webtools"] as const;
const USAGE = "Usage: /ollama [usage | status [on|off] | webtools [on|off]]";
/**
 * Request statistics refresh at most this often in the panel: the usage endpoint
 * has been observed to allow about five reads a minute before returning 429.
 */
const PANEL_STATS_INTERVAL_MS = 15_000;

/** Intervals the panel uses; tests shorten them. */
export interface OllamaCommandOptions {
  reportIntervalMs?: number;
  rateLimitedIntervalMs?: number;
  statsIntervalMs?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ollamaCommandCompletions(prefix: string): AutocompleteItem[] | null {
  const words = prefix.trimStart().split(/\s+/);
  if (words.length === 1) {
    return SUBCOMMANDS.filter((name) => name.startsWith(words[0])).map((name) => ({ value: name, label: name }));
  }
  if (words.length === 2 && (words[0] === "status" || words[0] === "webtools")) {
    // Pi replaces the whole argument text with the chosen value.
    return ["on", "off"]
      .filter((value) => value.startsWith(words[1]))
      .map((value) => ({ value: `${words[0]} ${value}`, label: value }));
  }
  return null;
}

/** Save one toggle globally and explain any layer that will override it at the next start. */
function saveSetting(patch: OllamaCloudConfig, cwd: string, applied: string): PanelMessage {
  let path: string;
  try {
    path = saveGlobalConfig(patch);
  } catch (error) {
    return { level: "warning", text: `${applied} Applied for this run only: ${errorText(error)}` };
  }
  const notes: string[] = [];
  const layers = readConfigLayers(cwd);
  for (const [key, value] of Object.entries(patch) as [keyof OllamaCloudConfig, boolean][]) {
    const projectValue = layers.project[key];
    if (projectValue !== undefined && projectValue !== value) {
      notes.push(`${layers.projectPath} sets ${key} to ${projectValue} and takes precedence when Pi starts.`);
    }
    if (key === "webTools" && resolveWebToolsEnv() !== undefined) {
      notes.push("PI_OLLAMA_WEB_TOOLS takes precedence when Pi starts.");
    }
  }
  return { level: notes.length > 0 ? "warning" : "info", text: [`${applied} Saved to ${path}.`, ...notes].join(" ") };
}

function setUsageStatus(enabled: boolean, ctx: ExtensionContext, controls: SettingsControls): PanelMessage {
  controls.setUsageStatusEnabled(enabled, ctx);
  return saveSetting({ usageStatus: enabled }, ctx.cwd, `Usage status bar ${enabled ? "on" : "off"}.`);
}

function setWebTools(enabled: boolean, ctx: ExtensionContext, controls: SettingsControls): PanelMessage {
  if (resolveWebToolsEnv() === false) {
    return { level: "error", text: "Web tools are disabled by PI_OLLAMA_WEB_TOOLS; unset it to change this setting." };
  }
  controls.setWebToolsEnabled(enabled);
  return saveSetting({ webTools: enabled }, ctx.cwd, `Web tools ${enabled ? "on" : "off"}.`);
}

function toggleNote(key: keyof OllamaCloudConfig, cwd: string): string {
  const layers = readConfigLayers(cwd);
  const notes = [`Saved to ${globalConfigPath()}.`];
  if (layers.project[key] !== undefined) notes.push(`${layers.projectPath} overrides it when Pi starts.`);
  if (key === "webTools" && resolveWebToolsEnv() !== undefined) notes.push("PI_OLLAMA_WEB_TOOLS overrides it.");
  return notes.join(" ");
}

async function loadPanelView(
  ctx: ExtensionContext,
  services: AccountServices,
  controls: SettingsControls,
): Promise<PanelView> {
  const { router, binding } = services;
  const { accounts, problems } = await router.listAccounts(await getCloudApiKey(ctx));
  const state = router.readState();
  const nowMs = Date.now();
  return {
    usageStatus: {
      enabled: controls.isUsageStatusEnabled(),
      description: `Footer usage of this session's account while an ollama-cloud model is active. ${toggleNote("usageStatus", ctx.cwd)}`,
    },
    webTools: {
      enabled: resolveWebToolsEnv() !== false && controls.areWebToolsEnabled(),
      isLocked: resolveWebToolsEnv() === false,
      description:
        resolveWebToolsEnv() === false
          ? "Disabled by PI_OLLAMA_WEB_TOOLS; unset it to enable ollama_web_search and ollama_web_fetch."
          : `ollama_web_search and ollama_web_fetch, using this session's account. ${toggleNote("webTools", ctx.cwd)}`,
    },
    accounts: accounts.map((account) => {
      const overview = accountOverview(account, state, nowMs);
      const isSession = account.id === binding.accountId;
      const source =
        account.source === "pi" ? "Pi's ollama-cloud credential." : `Stored in ${router.credentials.path}.`;
      return {
        id: account.id,
        isSession,
        isDefault: account.source === "pi",
        isDisabled: overview.isDisabled,
        summary: [overview.keyPrefix, overview.usage ?? "usage not checked", overview.status].join("  "),
        description: [
          source,
          isSession ? "This session uses this account." : "",
          overview.usage ? `Usage: ${overview.usage} (checked ${overview.checked}).` : "Usage not checked yet.",
          `Status: ${overview.status}. Enter for actions.`,
        ]
          .filter(Boolean)
          .join(" "),
      };
    }),
    problems,
  };
}

async function addAccount(
  ctx: ExtensionContext,
  services: AccountServices,
  id: string,
  value: string,
): Promise<PanelMessage> {
  const { router } = services;
  await router.credentials.add(id, value);
  const { accounts, problems } = await router.listAccounts(await getCloudApiKey(ctx));
  const added = accounts.find((account) => account.id === id);
  if (!added) {
    await router.credentials.remove(id);
    const reason = problems.find((problem) => problem.id === id)?.error ?? "the entry is unusable";
    return { level: "error", text: `Account "${id}" was not saved: ${reason}` };
  }
  try {
    const data = await fetchUsage(added.apiKey);
    await router.recordBalance(added, data);
    const summary = formatUsageSummary(data);
    return { level: "info", text: `Added Ollama Cloud account "${id}".${summary ? ` ${summary}` : ""}` };
  } catch (error) {
    if (classifyThrownError(error)?.kind === "unauthorized") {
      await router.credentials.remove(id);
      return { level: "error", text: `Ollama Cloud rejected the key for "${id}"; the account was not saved.` };
    }
    return {
      level: "warning",
      text: `Added account "${id}", but its balance could not be checked: ${errorText(error)}`,
    };
  }
}

async function runAccountAction(
  ctx: ExtensionContext,
  services: AccountServices,
  id: string,
  action: AccountAction,
): Promise<PanelMessage> {
  const { router, binding } = services;
  const { accounts } = await router.listAccounts(await getCloudApiKey(ctx));
  const account = accounts.find((item) => item.id === id);
  if (!account) return { level: "error", text: `No usable Ollama Cloud account named "${id}".` };
  const switchNote = binding.accountId === id ? " This session switches to the next account on its next request." : "";
  if (action === "use") {
    const reason = accountUnavailableReason(account, router.readState(), Date.now());
    if (reason) return { level: "error", text: `Account "${id}" is unavailable (${reason}).` };
    binding.bind(id);
    return { level: "info", text: `This session now uses Ollama Cloud account "${id}".` };
  }
  if (action === "enable" || action === "disable") {
    await router.setDisabled(id, action === "disable");
    return { level: "info", text: `Account "${id}" ${action}d.${action === "disable" ? switchNote : ""}` };
  }
  if (action === "reset") {
    await router.resetHealth([account]);
    return { level: "info", text: `Cleared usage-limit and rejected-key markers for "${id}".` };
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    return { level: "error", text: "The default account is Pi's ollama-cloud credential; remove it with /logout." };
  }
  if (!(await router.credentials.remove(id))) return { level: "error", text: `No additional account named "${id}".` };
  return { level: "info", text: `Removed Ollama Cloud account "${id}".${switchNote}` };
}

/**
 * Fresh balances for every account, recorded for the router, plus request
 * statistics for the session's account (or the first one) at most every
 * `statsIntervalMs`. Returns a function that keeps the last statistics between calls.
 */
function createUsageReporter(ctx: ExtensionContext, services: AccountServices, statsIntervalMs: number) {
  let lastStats: { accountId: string; checkedAtMs: number; stats?: UsageStats } | undefined;
  return async (signal: AbortSignal): Promise<PanelUsageReport> => {
    const { router, binding } = services;
    const { accounts } = await router.listAccounts(await getCloudApiKey(ctx), signal);
    const entries = await Promise.all(
      accounts.map(async (account): Promise<PanelUsageEntry> => {
        const entry: PanelUsageEntry = { id: account.id, isSession: account.id === binding.accountId };
        try {
          const data = await fetchUsage(account.apiKey, signal);
          await router.recordBalance(account, data).catch(() => {});
          return { ...entry, data };
        } catch (error) {
          signal.throwIfAborted();
          const isRateLimited = error instanceof OllamaHttpError && error.status === 429;
          return { ...entry, error: errorText(error), isRateLimited };
        }
      }),
    );
    const statsAccount = accounts.find((account) => account.id === binding.accountId) ?? accounts[0];
    if (statsAccount) {
      const nowMs = Date.now();
      const previous = lastStats?.accountId === statsAccount.id ? lastStats : undefined;
      if (!previous || nowMs - previous.checkedAtMs >= statsIntervalMs) {
        try {
          const stats = await fetchUsageStats(statsAccount.apiKey, "7d", signal);
          lastStats = { accountId: statsAccount.id, checkedAtMs: nowMs, stats };
        } catch {
          signal.throwIfAborted();
          // Keep showing the previous statistics; retry after the same interval.
          lastStats = { accountId: statsAccount.id, checkedAtMs: nowMs, stats: previous?.stats };
        }
      }
      const entry = entries.find((item) => item.id === statsAccount.id);
      if (entry?.data && lastStats?.stats) entry.stats = lastStats.stats;
    }
    return { entries, checkedAtMs: Date.now() };
  };
}

async function openSettingsPanel(
  ctx: ExtensionCommandContext,
  services: AccountServices,
  controls: SettingsControls,
  options: OllamaCommandOptions,
): Promise<void> {
  let knownIds = new Set<string>();
  const load = async () => {
    const view = await loadPanelView(ctx, services, controls);
    knownIds = new Set([...view.accounts.map((account) => account.id), ...view.problems.map((problem) => problem.id)]);
    return view;
  };
  const actions: SettingsPanelActions = {
    load,
    fetchUsageReport: createUsageReporter(ctx, services, options.statsIntervalMs ?? PANEL_STATS_INTERVAL_MS),
    setUsageStatus: async (enabled) => setUsageStatus(enabled, ctx, controls),
    setWebTools: async (enabled) => setWebTools(enabled, ctx, controls),
    runAccountAction: (id, action) => runAccountAction(ctx, services, id, action),
    validateAccountId: (id) =>
      validateAccountIdFormat(id) ?? (knownIds.has(id) ? `Account "${id}" already exists.` : undefined),
    suggestAccountId: () => {
      let index = 1;
      while (knownIds.has(`account-${index}`)) index += 1;
      return `account-${index}`;
    },
    addAccount: (id, value) => addAccount(ctx, services, id, value),
  };
  const view = await load();
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new OllamaSettingsPanel({
        renderer: tui,
        theme,
        view,
        actions,
        done: () => done(),
        keyPrefixLength: VISIBLE_KEY_PREFIX_LENGTH,
        reportIntervalMs: options.reportIntervalMs,
        rateLimitedIntervalMs: options.rateLimitedIntervalMs,
      }),
  );
}

async function settingsSummary(
  ctx: ExtensionContext,
  services: AccountServices,
  controls: SettingsControls,
): Promise<string> {
  const { router, binding } = services;
  const { accounts, problems } = await router.listAccounts(await getCloudApiKey(ctx));
  const webTools =
    resolveWebToolsEnv() === false ? "off (PI_OLLAMA_WEB_TOOLS)" : controls.areWebToolsEnabled() ? "on" : "off";
  return [
    "Ollama Cloud settings",
    `  Usage status bar: ${controls.isUsageStatusEnabled() ? "on" : "off"}`,
    `  Web tools: ${webTools}`,
    formatAccountsReport({
      accounts,
      problems,
      state: router.readState(),
      boundAccountId: binding.accountId,
      nowMs: Date.now(),
      accountsPath: router.credentials.path,
    }),
    "Open /ollama in the TUI to manage accounts, or use /ollama status|webtools [on|off] and /ollama usage.",
  ].join("\n");
}

async function handleOllamaCommand(
  args: string,
  ctx: ExtensionCommandContext,
  services: AccountServices,
  controls: SettingsControls,
  options: OllamaCommandOptions,
): Promise<void> {
  const [subcommand, value, ...extra] = args.trim().split(/\s+/).filter(Boolean);
  try {
    if (subcommand === undefined) {
      if (ctx.mode === "tui" && ctx.hasUI) await openSettingsPanel(ctx, services, controls, options);
      else ctx.ui.notify(await settingsSummary(ctx, services, controls), "info");
      return;
    }
    if (subcommand === "usage" && value === undefined) {
      await showCloudUsage(ctx, services);
      return;
    }
    if ((subcommand === "status" || subcommand === "webtools") && extra.length === 0) {
      const isStatus = subcommand === "status";
      const current = isStatus ? controls.isUsageStatusEnabled() : controls.areWebToolsEnabled();
      const toggle = resolveToggleArgument(value ?? "", current, `/ollama ${subcommand} [on|off]`);
      if (toggle.error) {
        ctx.ui.notify(toggle.error, "error");
        return;
      }
      const message = isStatus
        ? setUsageStatus(toggle.enabled, ctx, controls)
        : setWebTools(toggle.enabled, ctx, controls);
      ctx.ui.notify(message.text, message.level);
      return;
    }
    ctx.ui.notify(USAGE, "error");
  } catch (error) {
    ctx.ui.notify(`Ollama Cloud: ${errorText(error)}`, "error");
  }
}

export function registerOllamaCommand(
  pi: ExtensionAPI,
  services: AccountServices,
  controls: SettingsControls,
  options: OllamaCommandOptions = {},
) {
  pi.registerCommand("ollama", {
    description:
      "Ollama Cloud settings with a live usage report, accounts, the usage status bar, and web tools. " +
      "Arguments: usage, status [on|off], webtools [on|off].",
    getArgumentCompletions: ollamaCommandCompletions,
    handler: (args, ctx) => handleOllamaCommand(args, ctx, services, controls, options),
  });
}
