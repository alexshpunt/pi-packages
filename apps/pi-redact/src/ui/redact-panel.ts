import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { onOff, type RedactStatus, statusLines } from "../status.js";
import { errorText, hint, messageLines, type PanelMessage, paragraph, title } from "./common.js";

export interface RedactPanelOptions {
  readonly theme: Theme;
  getStatus(): RedactStatus;
  setSessionEnabled(isEnabled: boolean): void;
  setGlobalEnabled(isEnabled: boolean): Promise<void>;
  requestRender(): void;
  onClose(): void;
}

function sessionDescription(status: RedactStatus): string {
  const now =
    status.sessionChoice === undefined ? "It now follows the global default." : "It now overrides the global default.";
  return `Applies only to this session and is saved with it, so resuming the session keeps it. ${now}`;
}

function globalDescription(status: RedactStatus): string {
  return `Saved in ${status.globalSettingsPath}. New sessions, and sessions without their own choice, use it.`;
}

/** `/redact`: the current state, then this session's and the global switch. */
export class RedactPanel implements Component {
  readonly #options: RedactPanelOptions;
  readonly #list: SettingsList;
  readonly #session: SettingItem;
  readonly #global: SettingItem;
  /** Read when the page opens and after each change, not on every frame: it counts analytics records. */
  #status: RedactStatus;
  #message: PanelMessage | undefined;
  #isBusy = false;
  #isClosed = false;
  #shouldCloseAfterSave = false;

  constructor(options: RedactPanelOptions) {
    this.#options = options;
    const status = options.getStatus();
    this.#status = status;
    this.#session = {
      id: "session",
      label: "This session",
      currentValue: onOff(status.isEnabled),
      values: ["on", "off"],
      description: sessionDescription(status),
    };
    this.#global = {
      id: "global",
      label: "Global default",
      currentValue: onOff(status.isEnabledByDefault),
      values: ["on", "off"],
      description: globalDescription(status),
    };
    this.#list = new SettingsList(
      [this.#session, this.#global],
      2,
      getSettingsListTheme(),
      (id, value) => this.#change(id, value === "on"),
      () => this.#close(),
    );
  }

  /** Show the saved state; SettingsList changes its value before the change is applied. */
  #sync(): void {
    const status = this.#options.getStatus();
    this.#status = status;
    this.#list.updateValue("session", onOff(status.isEnabled));
    this.#list.updateValue("global", onOff(status.isEnabledByDefault));
    this.#session.description = sessionDescription(status);
    this.#global.description = globalDescription(status);
    this.#list.invalidate();
  }

  #change(id: string, isEnabled: boolean): void {
    if (this.#isBusy || this.#isClosed) return;
    if (id === "session") {
      try {
        this.#options.setSessionEnabled(isEnabled);
        this.#message = { text: `Masking is ${onOff(isEnabled)} for this session.`, isError: false };
      } catch (error) {
        this.#message = { text: errorText(error), isError: true };
      }
      this.#sync();
      return;
    }
    if (id === "global") void this.#saveGlobal(isEnabled);
  }

  async #saveGlobal(isEnabled: boolean): Promise<void> {
    this.#isBusy = true;
    this.#message = { text: "Saving…", isError: false };
    this.#sync();
    this.#options.requestRender();
    try {
      await this.#options.setGlobalEnabled(isEnabled);
      this.#message = { text: `The global default is now ${onOff(isEnabled)}.`, isError: false };
    } catch (error) {
      this.#message = { text: errorText(error), isError: true };
    } finally {
      this.#isBusy = false;
      if (!this.#isClosed) {
        this.#sync();
        if (this.#shouldCloseAfterSave) this.#close();
        else this.#options.requestRender();
      }
    }
  }

  #close(): void {
    if (this.#isClosed) return;
    if (this.#isBusy) {
      this.#shouldCloseAfterSave = true;
      return;
    }
    this.#isClosed = true;
    this.#options.onClose();
  }

  handleInput(data: string): void {
    if (this.#isClosed) return;
    if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.#close();
      return;
    }
    if (this.#isBusy) return;
    this.#list.handleInput(data);
    this.#options.requestRender();
  }

  render(width: number): string[] {
    const { theme } = this.#options;
    const status = this.#status;
    const [masking = "", ...details] = statusLines(status);
    return [
      title(theme, "Redact", width),
      "",
      ...paragraph(theme.fg(status.isEnabled ? "success" : "warning", masking), width),
      ...paragraph(theme.fg("muted", details.join("\n")), width),
      "",
      ...this.#list.render(width),
      ...(this.#message ? ["", ...messageLines(theme, this.#message, width)] : []),
      "",
      hint(theme, "Edit rules with /redact-custom · See what was masked with /redact-analytics", width),
    ];
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  dispose(): void {
    this.#isClosed = true;
  }
}
