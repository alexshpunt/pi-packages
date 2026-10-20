import { getSelectListTheme, getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  getKeybindings,
  Input,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { formatUsageDetails, formatUsageStatusColored, type UsageData, type UsageStats } from "../usage/api.ts";
import { SecretInput } from "./secret-input.ts";

/** Usage report refresh interval while the panel is open. */
export const USAGE_REPORT_INTERVAL_MS = 5_000;
/** Delay after a rate-limited balance check. */
export const USAGE_REPORT_BACKOFF_MS = 30_000;

export interface PanelToggle {
  enabled: boolean;
  /** A locked toggle is shown but cannot be changed here (for example an environment override). */
  isLocked?: boolean;
  description: string;
}

export interface PanelAccount {
  id: string;
  isSession: boolean;
  isDefault: boolean;
  isDisabled: boolean;
  /** Right-hand summary: key prefix, usage, and availability. */
  summary: string;
  description: string;
}

export interface PanelView {
  usageStatus: PanelToggle;
  webTools: PanelToggle;
  accounts: PanelAccount[];
  problems: { id: string; error: string }[];
}

export interface PanelMessage {
  level: "info" | "warning" | "error";
  text: string;
}

export type AccountAction = "use" | "enable" | "disable" | "reset" | "remove";

export interface PanelUsageEntry {
  id: string;
  isSession: boolean;
  data?: UsageData;
  /** Request statistics, fetched for the session's account only. */
  stats?: UsageStats;
  error?: string;
  isRateLimited?: boolean;
}

export interface PanelUsageReport {
  entries: PanelUsageEntry[];
  checkedAtMs: number;
}

/** Operations the panel triggers; implemented by the /ollama command against real state. */
export interface SettingsPanelActions {
  load(): Promise<PanelView>;
  /** Fresh balances for every account; the panel calls it repeatedly while open. */
  fetchUsageReport(signal: AbortSignal): Promise<PanelUsageReport>;
  setUsageStatus(enabled: boolean): Promise<PanelMessage>;
  setWebTools(enabled: boolean): Promise<PanelMessage>;
  runAccountAction(id: string, action: AccountAction): Promise<PanelMessage>;
  validateAccountId(id: string): string | undefined;
  /** An unused account name offered as the default, e.g. `account-1`. */
  suggestAccountId(): string;
  addAccount(id: string, value: string): Promise<PanelMessage>;
}

export interface PanelRenderer {
  requestRender(): void;
}

const ON = "on";
const OFF = "off";
const MAX_VISIBLE_ITEMS = 14;
const ADD_ITEM_ID = "add";
const accountItemId = (id: string) => `account:${id}`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageColor(level: PanelMessage["level"]) {
  return level === "error" ? "error" : level === "warning" ? "warning" : "accent";
}

function shapeOf(view: PanelView): string {
  return JSON.stringify([view.accounts.map((account) => account.id), view.problems.map((problem) => problem.id)]);
}

/** Actions for one account; removal asks for confirmation first. */
class AccountMenu implements Component {
  private readonly list: SelectList;
  private readonly account: PanelAccount;
  private readonly theme: Theme;
  private readonly finish: (action: AccountAction | undefined) => void;
  private isConfirmingRemoval = false;

  constructor(account: PanelAccount, theme: Theme, finish: (action: AccountAction | undefined) => void) {
    this.account = account;
    this.theme = theme;
    this.finish = finish;
    const items: SelectItem[] = [];
    if (!account.isSession && !account.isDisabled) {
      items.push({ value: "use", label: "Use for this session", description: "Bind this session to the account" });
    }
    items.push(
      account.isDisabled
        ? { value: "enable", label: "Enable", description: "Include the account in the rotation again" }
        : { value: "disable", label: "Disable", description: "Skip the account in the rotation" },
      { value: "reset", label: "Clear limit markers", description: "Forget usage-limit and rejected-key markers" },
    );
    if (!account.isDefault) {
      items.push({ value: "remove", label: "Remove account", description: "Delete it from the accounts file" });
    }
    this.list = new SelectList(items, items.length, getSelectListTheme());
    this.list.onSelect = (item) => {
      if (item.value === "remove") this.isConfirmingRemoval = true;
      else finish(item.value as AccountAction);
    };
    this.list.onCancel = () => finish(undefined);
  }

  render(width: number): string[] {
    const title = truncateToWidth(this.theme.fg("accent", `Account ${this.account.id}`), width);
    if (this.isConfirmingRemoval) {
      return [
        title,
        truncateToWidth(`Remove "${this.account.id}" from the accounts file?`, width),
        truncateToWidth(this.theme.fg("dim", "Enter removes it, Esc keeps it."), width),
      ];
    }
    return [title, ...this.list.render(width)];
  }

  handleInput(data: string): void {
    if (this.isConfirmingRemoval) {
      const keys = getKeybindings();
      if (keys.matches(data, "tui.select.confirm")) this.finish("remove");
      else if (keys.matches(data, "tui.select.cancel")) this.isConfirmingRemoval = false;
      return;
    }
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

interface AddResult {
  message: PanelMessage;
  accountId?: string;
}

/** Longest name rendered as typed; anything longer, or with a dot, is probably a pasted key. */
const MAX_VISIBLE_NAME_LENGTH = 32;
const looksLikeKey = (value: string) => value.length > MAX_VISIBLE_NAME_LENGTH || value.includes(".");

/**
 * The key comes first so the field most likely to receive a pasted key is always
 * masked; the account name follows, with an unused default used when left empty.
 */
class AddAccountForm implements Component, Focusable {
  private readonly keyInput: SecretInput;
  private readonly nameInput: Input;
  private readonly suggestedName: string;
  private readonly theme: Theme;
  private readonly actions: SettingsPanelActions;
  private readonly finish: (result: AddResult | undefined) => void;
  private readonly rerender: () => void;
  private readonly keyPrefixLength: number;
  private step: "key" | "name" | "saving" = "key";
  private key = "";
  private accountId = "";
  private error: string | undefined;
  private isFocused = false;

  constructor(
    theme: Theme,
    actions: SettingsPanelActions,
    keyPrefixLength: number,
    finish: (result: AddResult | undefined) => void,
    rerender: () => void,
  ) {
    this.theme = theme;
    this.actions = actions;
    this.keyPrefixLength = keyPrefixLength;
    this.finish = finish;
    this.rerender = rerender;
    this.keyInput = new SecretInput(
      "Paste the Ollama Cloud API key, or a $ENV/!command reference",
      theme,
      (value) => this.submitKey(value),
      { visiblePrefixLength: keyPrefixLength },
    );
    this.suggestedName = actions.suggestAccountId();
    this.nameInput = new Input({
      placeholder: `${this.suggestedName} (Enter to use)`,
      placeholderStyle: (text) => theme.fg("dim", text),
    });
    this.nameInput.onSubmit = (value) => this.submitName(value);
    this.nameInput.onEscape = () => finish(undefined);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.keyInput.focused = value && this.step === "key";
    this.nameInput.focused = value && this.step === "name";
  }

  private submitKey(value: string | undefined) {
    if (value === undefined) {
      this.finish(undefined);
      return;
    }
    if (!value.trim()) {
      this.error = "Enter an API key or reference, or press Esc to cancel.";
      return;
    }
    this.key = value.trim();
    this.error = undefined;
    this.step = "name";
    this.focused = this.isFocused;
  }

  private submitName(value: string) {
    const id = value.trim() || this.suggestedName;
    const error = this.actions.validateAccountId(id);
    if (error) {
      this.error = looksLikeKey(id)
        ? "That looks like an API key. This field is the account name, for example work."
        : error;
      return;
    }
    this.accountId = id;
    this.step = "saving";
    this.error = undefined;
    this.focused = this.isFocused;
    this.rerender();
    this.actions.addAccount(id, this.key).then(
      (message) => this.finish({ message, accountId: message.level === "error" ? undefined : id }),
      (error: unknown) => this.finish({ message: { level: "error", text: errorText(error) } }),
    );
  }

  handleInput(data: string): void {
    if (this.step === "key") this.keyInput.handleInput(data);
    else if (this.step === "name") this.nameInput.handleInput(data);
  }

  private renderName(width: number): string[] {
    const value = this.nameInput.getValue();
    if (!looksLikeKey(value)) return this.nameInput.render(width);
    // Never echo a pasted key in full, even in the name field.
    const masked = `${value.slice(0, this.keyPrefixLength)}${"•".repeat(Math.max(value.length - this.keyPrefixLength, 0))}`;
    return [truncateToWidth(`> ${masked}`, width, "")];
  }

  render(width: number): string[] {
    const lines = [truncateToWidth(this.theme.fg("accent", "Add Ollama Cloud account"), width)];
    if (this.step === "key") {
      lines.push(...this.keyInput.render(width));
    } else if (this.step === "name") {
      lines.push(
        truncateToWidth("Account name (1-32 lowercase letters, digits, - or _):", width),
        ...this.renderName(width),
        truncateToWidth(this.theme.fg("dim", "Enter saves, Esc cancels."), width),
      );
    } else {
      lines.push(truncateToWidth(`Saving "${this.accountId}" and checking its balance…`, width));
    }
    if (this.error) lines.push(truncateToWidth(this.theme.fg("error", this.error), width));
    return lines;
  }

  invalidate(): void {
    this.keyInput.invalidate();
    this.nameInput.invalidate();
  }
}

export interface SettingsPanelOptions {
  renderer: PanelRenderer;
  theme: Theme;
  view: PanelView;
  actions: SettingsPanelActions;
  done: () => void;
  /** Leading key characters shown while adding an account. */
  keyPrefixLength: number;
  reportIntervalMs?: number;
  rateLimitedIntervalMs?: number;
}

/**
 * `/ollama` settings panel: a live usage report under the title, the usage
 * status bar and web tools toggles, and the account list with per-account
 * actions and account adding. The report refreshes only while the panel is open.
 */
export class OllamaSettingsPanel implements Component, Focusable {
  private readonly renderer: PanelRenderer;
  private readonly theme: Theme;
  private readonly actions: SettingsPanelActions;
  private readonly done: () => void;
  private readonly keyPrefixLength: number;
  private readonly reportIntervalMs: number;
  private readonly rateLimitedIntervalMs: number;
  private readonly items = new Map<string, SettingItem>();
  private view: PanelView;
  private list: SettingsList;
  private form: (Component & Partial<Focusable>) | undefined;
  private pendingView: PanelView | undefined;
  private message: PanelMessage | undefined;
  private report: PanelUsageReport | undefined;
  private reportError: string | undefined;
  private reportTimer: ReturnType<typeof setTimeout> | undefined;
  private reportAbort: AbortController | undefined;
  private nextReportDelayMs: number;
  private isFocused = false;
  private isClosed = false;

  constructor(options: SettingsPanelOptions) {
    this.renderer = options.renderer;
    this.theme = options.theme;
    this.actions = options.actions;
    this.done = options.done;
    this.keyPrefixLength = options.keyPrefixLength;
    this.reportIntervalMs = options.reportIntervalMs ?? USAGE_REPORT_INTERVAL_MS;
    this.rateLimitedIntervalMs = options.rateLimitedIntervalMs ?? USAGE_REPORT_BACKOFF_MS;
    this.nextReportDelayMs = this.reportIntervalMs;
    this.view = options.view;
    this.list = this.buildList();
    void this.refreshReport();
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    if (this.form && "focused" in this.form) this.form.focused = value;
  }

  private toggleItem(id: string, label: string, toggle: PanelToggle): SettingItem {
    return {
      id,
      label,
      currentValue: toggle.enabled ? ON : OFF,
      values: toggle.isLocked ? undefined : [ON, OFF],
      description: toggle.description,
    };
  }

  private buildList(selectedId?: string): SettingsList {
    this.items.clear();
    const items: SettingItem[] = [
      this.toggleItem("usageStatus", "Usage status bar", this.view.usageStatus),
      this.toggleItem("webTools", "Web tools", this.view.webTools),
    ];
    for (const account of this.view.accounts) {
      items.push({
        id: accountItemId(account.id),
        label: `${account.id}${account.isSession ? " *" : ""}`,
        currentValue: account.summary,
        description: account.description,
        submenu: (_value, close) => this.openAccountMenu(account, close),
      });
    }
    for (const problem of this.view.problems) {
      items.push({
        id: `problem:${problem.id}`,
        label: problem.id,
        currentValue: "unusable",
        description: problem.error,
      });
    }
    items.push({
      id: ADD_ITEM_ID,
      label: "+ Add account",
      currentValue: "",
      description: "Store another Ollama Cloud API key. New sessions take accounts in turn; each session keeps one.",
      submenu: (_value, close) => this.openAddForm(close),
    });
    for (const item of items) this.items.set(item.id, item);
    const list = new SettingsList(
      items,
      Math.min(items.length, MAX_VISIBLE_ITEMS),
      getSettingsListTheme(),
      (id, value) => this.onToggle(id, value),
      () => this.close(),
    );
    if (selectedId) list.selectItem(selectedId);
    return list;
  }

  /** Update values in place so the cursor stays put; rebuild only when accounts were added or removed. */
  private applyView(view: PanelView, selectedId?: string) {
    if (this.form) {
      this.pendingView = view;
      return;
    }
    const isSameShape = shapeOf(view) === shapeOf(this.view);
    this.view = view;
    if (!isSameShape) {
      this.list = this.buildList(selectedId);
    } else {
      const update = (id: string, value: Partial<SettingItem>) => {
        const item = this.items.get(id);
        if (item) Object.assign(item, value);
      };
      const toggles = [
        ["usageStatus", view.usageStatus],
        ["webTools", view.webTools],
      ] as const;
      for (const [id, toggle] of toggles) {
        update(id, {
          currentValue: toggle.enabled ? ON : OFF,
          values: toggle.isLocked ? undefined : [ON, OFF],
          description: toggle.description,
        });
      }
      for (const account of view.accounts) {
        update(accountItemId(account.id), {
          label: `${account.id}${account.isSession ? " *" : ""}`,
          currentValue: account.summary,
          description: account.description,
          submenu: (_value, close) => this.openAccountMenu(account, close),
        });
      }
      this.list.invalidate();
    }
    this.renderer.requestRender();
  }

  private applyPendingView() {
    const pending = this.pendingView;
    this.pendingView = undefined;
    if (pending) this.applyView(pending);
    else this.renderer.requestRender();
  }

  private async reload(selectedId?: string) {
    try {
      const view = await this.actions.load();
      if (!this.isClosed) this.applyView(view, selectedId);
    } catch (error) {
      if (this.isClosed) return;
      this.message = { level: "error", text: errorText(error) };
      this.renderer.requestRender();
    }
  }

  /** One report cycle, then schedule the next; a slow check delays the next one instead of overlapping it. */
  private async refreshReport() {
    this.reportTimer = undefined;
    if (this.isClosed) return;
    const controller = new AbortController();
    this.reportAbort = controller;
    let delayMs = this.reportIntervalMs;
    try {
      const report = await this.actions.fetchUsageReport(controller.signal);
      if (this.isClosed) return;
      this.report = report;
      this.reportError = undefined;
      if (report.entries.some((entry) => entry.isRateLimited)) delayMs = this.rateLimitedIntervalMs;
      // Account rows show the balances the report just recorded.
      await this.reload();
    } catch (error) {
      if (this.isClosed) return;
      this.reportError = errorText(error);
    } finally {
      if (this.reportAbort === controller) this.reportAbort = undefined;
    }
    if (this.isClosed) return;
    this.nextReportDelayMs = delayMs;
    this.renderer.requestRender();
    const timer = setTimeout(() => void this.refreshReport(), delayMs);
    // An open panel must not keep Pi alive on exit.
    timer.unref?.();
    this.reportTimer = timer;
  }

  private stopReport() {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = undefined;
    this.reportAbort?.abort();
    this.reportAbort = undefined;
  }

  private renderReport(width: number): string[] {
    const report = this.report;
    if (!report) return [truncateToWidth(this.theme.fg("dim", "  Checking usage…"), width)];
    const names = report.entries.map((entry) => `${entry.id}${entry.isSession ? " *" : ""}`);
    const nameWidth = Math.min(Math.max(...names.map((name) => name.length), 4), 24);
    const indent = " ".repeat(nameWidth + 4);
    const lines: string[] = [];
    report.entries.forEach((entry, index) => {
      const name = names[index].padEnd(nameWidth);
      if (entry.error) {
        const color = entry.isRateLimited ? "warning" : "error";
        lines.push(truncateToWidth(`  ${name}  ${this.theme.fg(color, entry.error)}`, width));
        return;
      }
      const bars = entry.data ? formatUsageStatusColored(this.theme, entry.data) : "";
      lines.push(truncateToWidth(`  ${name}  ${bars || this.theme.fg("dim", "no quota data")}`, width));
      const details = entry.data ? formatUsageDetails(entry.data, entry.stats).join(" · ") : "";
      if (details) lines.push(truncateToWidth(this.theme.fg("dim", `${indent}${details}`), width));
    });
    const checkedAt = new Date(report.checkedAtMs).toTimeString().slice(0, 8);
    const seconds = Math.round(this.nextReportDelayMs / 1000);
    const cadence =
      this.nextReportDelayMs > this.reportIntervalMs
        ? `rate limited, next check in ${seconds}s`
        : `refreshes every ${seconds}s while open`;
    lines.push(truncateToWidth(this.theme.fg("dim", `  Updated ${checkedAt} · ${cadence}`), width));
    if (this.reportError) lines.push(truncateToWidth(this.theme.fg("error", `  ${this.reportError}`), width));
    return lines;
  }

  private async perform(task: () => Promise<PanelMessage>, selectedId?: string) {
    this.message = { level: "info", text: "Working…" };
    this.renderer.requestRender();
    let message: PanelMessage;
    try {
      message = await task();
    } catch (error) {
      message = { level: "error", text: errorText(error) };
    }
    if (this.isClosed) return;
    this.message = message;
    await this.reload(selectedId);
  }

  private onToggle(id: string, value: string) {
    if (id === "usageStatus") void this.perform(() => this.actions.setUsageStatus(value === ON));
    else if (id === "webTools") void this.perform(() => this.actions.setWebTools(value === ON));
  }

  private openAccountMenu(account: PanelAccount, close: () => void): Component {
    const menu = new AccountMenu(account, this.theme, (action) => {
      this.form = undefined;
      close();
      if (!action) {
        this.applyPendingView();
        return;
      }
      const selectedId = action === "remove" ? ADD_ITEM_ID : accountItemId(account.id);
      void this.perform(() => this.actions.runAccountAction(account.id, action), selectedId);
    });
    this.form = menu;
    return menu;
  }

  private openAddForm(close: () => void): Component {
    const form = new AddAccountForm(
      this.theme,
      this.actions,
      this.keyPrefixLength,
      (result) => {
        this.form = undefined;
        close();
        if (!result) {
          this.applyPendingView();
          return;
        }
        this.message = result.message;
        void this.reload(result.accountId ? accountItemId(result.accountId) : ADD_ITEM_ID);
      },
      () => this.renderer.requestRender(),
    );
    form.focused = this.isFocused;
    this.form = form;
    return form;
  }

  private close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.stopReport();
    this.done();
  }

  render(width: number): string[] {
    const lines = [truncateToWidth(this.theme.fg("accent", this.theme.bold("Ollama Cloud")), width)];
    lines.push(...this.renderReport(width), "");
    lines.push(...this.list.render(width));
    if (this.message) {
      lines.push("", truncateToWidth(this.theme.fg(messageColor(this.message.level), this.message.text), width));
    }
    return lines;
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
    this.renderer.requestRender();
  }

  invalidate(): void {
    this.list.invalidate();
  }

  dispose(): void {
    this.isClosed = true;
    this.stopReport();
  }
}
