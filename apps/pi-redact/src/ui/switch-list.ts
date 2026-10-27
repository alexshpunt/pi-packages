import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { errorText } from "../notify.js";
import { messageLines, type PanelMessage, paragraph, title } from "./common.js";

export interface SwitchItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface SwitchListOptions {
  readonly theme: Theme;
  readonly heading: string;
  readonly intro: string;
  readonly items: readonly SwitchItem[];
  readonly isSearchable?: boolean;
  isOn(id: string): boolean;
  /** Save one switch; throws with a message the user can act on. */
  setOn(id: string, isOn: boolean): Promise<void>;
  requestRender(): void;
  onClose(): void;
}

const MAX_VISIBLE_ITEMS = 12;
const onOff = (isOn: boolean) => (isOn ? "on" : "off");

/** A list of on/off switches; each change is saved before the next one is accepted. */
export class SwitchList implements Component {
  readonly #options: SwitchListOptions;
  readonly #list: SettingsList;
  #message: PanelMessage | undefined;
  #isBusy = false;
  #isClosed = false;

  constructor(options: SwitchListOptions) {
    this.#options = options;
    const items: SettingItem[] = options.items.map((item) => ({
      ...item,
      currentValue: onOff(options.isOn(item.id)),
      values: ["on", "off"],
    }));
    this.#list = new SettingsList(
      items,
      Math.min(items.length, MAX_VISIBLE_ITEMS),
      getSettingsListTheme(),
      (id, value) => void this.#change(id, value === "on"),
      () => this.#close(),
      { enableSearch: options.isSearchable === true },
    );
  }

  #sync(): void {
    for (const item of this.#options.items) this.#list.updateValue(item.id, onOff(this.#options.isOn(item.id)));
  }

  async #change(id: string, isOn: boolean): Promise<void> {
    if (this.#isBusy || this.#isClosed) return;
    this.#isBusy = true;
    this.#sync();
    this.#message = { text: "Saving…", isError: false };
    this.#options.requestRender();
    try {
      await this.#options.setOn(id, isOn);
      this.#message = { text: `Saved: ${id} is ${onOff(isOn)}.`, isError: false };
    } catch (error) {
      this.#message = { text: errorText(error), isError: true };
    } finally {
      this.#isBusy = false;
      if (!this.#isClosed) {
        this.#sync();
        this.#options.requestRender();
      }
    }
  }

  #close(): void {
    if (this.#isClosed || this.#isBusy) return;
    this.#isClosed = true;
    this.#options.onClose();
  }

  handleInput(data: string): void {
    if (this.#isClosed || this.#isBusy) return;
    // The list closes on its cancel key.
    this.#list.handleInput(data);
  }

  render(width: number): string[] {
    const { theme } = this.#options;
    return [
      title(theme, this.#options.heading, width),
      ...paragraph(theme.fg("muted", this.#options.intro), width),
      "",
      ...this.#list.render(width),
      ...(this.#message ? ["", ...messageLines(theme, this.#message, width)] : []),
    ];
  }

  invalidate(): void {
    this.#list.invalidate();
  }
}
