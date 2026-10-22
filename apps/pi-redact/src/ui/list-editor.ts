import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  getKeybindings,
  Input,
  type SelectItem,
  SelectList,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { errorText, hint, messageLines, type PanelMessage, paragraph, title } from "./common.js";

export interface FormField {
  readonly label: string;
  readonly placeholder?: string;
  /** Pick the value from these instead of typing it. */
  readonly choices?: readonly string[];
  readonly isOptional?: boolean;
}

export type BuildResult<T> = { readonly entry: T } | { readonly error: string };

export interface ListEditorOptions<T> {
  readonly theme: Theme;
  readonly heading: string;
  readonly intro: string;
  readonly addLabel: string;
  readonly emptyText: string;
  entries(): readonly T[];
  describe(entry: T): { readonly label: string; readonly description?: string };
  fields(): readonly FormField[];
  /** Form values that edit an existing entry; without it, entries can only be removed. */
  valuesOf?(entry: T): readonly string[];
  /** The entry the form describes, or a message to show instead. `index` is the entry being edited. */
  build(values: readonly string[], index: number | undefined): BuildResult<T>;
  /** Save the whole list; throws with a message the user can act on. */
  save(entries: readonly T[]): Promise<void>;
  requestRender(): void;
  onClose(): void;
}

const MAX_VISIBLE_ITEMS = 10;
const ADD_VALUE = "add";

type Mode =
  | { readonly kind: "list" }
  | { readonly kind: "actions"; readonly index: number; readonly menu: SelectList }
  | { readonly kind: "confirm"; readonly index: number }
  | {
      readonly kind: "form";
      readonly index: number | undefined;
      readonly values: string[];
      step: number;
      input?: Input;
      choices?: SelectList;
    };

/** Entries of one settings list, with add, edit, and remove; every change is saved at once. */
export class ListEditor<T> implements Component, Focusable {
  readonly #options: ListEditorOptions<T>;
  #list: SelectList;
  #mode: Mode = { kind: "list" };
  #message: PanelMessage | undefined;
  #isBusy = false;
  #isClosed = false;
  #isFocused = false;

  constructor(options: ListEditorOptions<T>) {
    this.#options = options;
    this.#list = this.#buildList();
  }

  get focused(): boolean {
    return this.#isFocused;
  }

  set focused(value: boolean) {
    this.#isFocused = value;
    if (this.#mode.kind === "form" && this.#mode.input) this.#mode.input.focused = value;
  }

  #buildList(selectedIndex = 0): SelectList {
    const items: SelectItem[] = this.#options.entries().map((entry, index) => ({
      value: String(index),
      ...this.#options.describe(entry),
    }));
    items.push({ value: ADD_VALUE, label: `+ ${this.#options.addLabel}` });
    const list = new SelectList(items, Math.min(items.length, MAX_VISIBLE_ITEMS), getSelectListTheme());
    list.setSelectedIndex(Math.min(selectedIndex, items.length - 1));
    list.onSelect = (item) => {
      this.#message = undefined;
      if (item.value === ADD_VALUE) this.#startForm(undefined);
      else this.#openEntry(Number(item.value));
    };
    list.onCancel = () => this.#close();
    return list;
  }

  #showList(selectedIndex?: number): void {
    this.#list = this.#buildList(selectedIndex);
    this.#mode = { kind: "list" };
  }

  #openEntry(index: number): void {
    if (!this.#options.valuesOf) {
      this.#mode = { kind: "confirm", index };
      return;
    }
    const menu = new SelectList(
      [
        { value: "edit", label: "Edit" },
        { value: "remove", label: "Remove" },
      ],
      2,
      getSelectListTheme(),
    );
    menu.onSelect = (item) => {
      if (item.value === "edit") this.#startForm(index);
      else this.#mode = { kind: "confirm", index };
    };
    menu.onCancel = () => this.#showList(index);
    this.#mode = { kind: "actions", index, menu };
  }

  #startForm(index: number | undefined): void {
    const entry = index === undefined ? undefined : this.#options.entries()[index];
    const values = entry !== undefined && this.#options.valuesOf ? [...this.#options.valuesOf(entry)] : [];
    this.#mode = { kind: "form", index, values, step: 0 };
    this.#prepareStep();
  }

  /** Create the input or choice list for the form's current field. */
  #prepareStep(): void {
    const mode = this.#mode;
    if (mode.kind !== "form") return;
    const field = this.#options.fields()[mode.step];
    if (!field) return;
    mode.input = undefined;
    mode.choices = undefined;
    const current = mode.values[mode.step] ?? "";
    if (field.choices) {
      const choices = new SelectList(
        field.choices.map((choice) => ({ value: choice, label: choice })),
        Math.min(field.choices.length, MAX_VISIBLE_ITEMS),
        getSelectListTheme(),
      );
      choices.setSelectedIndex(Math.max(0, field.choices.indexOf(current)));
      choices.onSelect = (item) => this.#submitField(item.value);
      choices.onCancel = () => this.#showList(mode.index);
      mode.choices = choices;
      return;
    }
    const input = new Input({
      placeholder: field.placeholder,
      placeholderStyle: (text) => this.#options.theme.fg("dim", text),
    });
    input.setValue(current);
    input.onSubmit = (value) => this.#submitField(value);
    input.onEscape = () => this.#showList(mode.index);
    input.focused = this.#isFocused;
    mode.input = input;
  }

  #submitField(rawValue: string): void {
    const mode = this.#mode;
    if (mode.kind !== "form") return;
    const fields = this.#options.fields();
    const field = fields[mode.step];
    const value = rawValue.trim();
    if (!value && !field?.isOptional) {
      this.#message = { text: "Enter a value, or press Esc to cancel.", isError: true };
      return;
    }
    mode.values[mode.step] = value;
    this.#message = undefined;
    if (mode.step + 1 < fields.length) {
      mode.step++;
      this.#prepareStep();
      return;
    }
    const built = this.#options.build(mode.values, mode.index);
    if ("error" in built) {
      // Start over with the typed values so any field can be corrected.
      this.#message = { text: built.error, isError: true };
      mode.step = 0;
      this.#prepareStep();
      return;
    }
    const entries = [...this.#options.entries()];
    if (mode.index === undefined) entries.push(built.entry);
    else entries[mode.index] = built.entry;
    void this.#save(entries, mode.index ?? entries.length - 1);
  }

  async #save(entries: readonly T[], selectedIndex: number): Promise<void> {
    this.#isBusy = true;
    this.#message = { text: "Saving…", isError: false };
    this.#options.requestRender();
    try {
      await this.#options.save(entries);
      this.#message = { text: "Saved.", isError: false };
    } catch (error) {
      this.#message = { text: errorText(error), isError: true };
    } finally {
      this.#isBusy = false;
      if (!this.#isClosed) {
        this.#showList(selectedIndex);
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
    const mode = this.#mode;
    switch (mode.kind) {
      case "list":
        this.#list.handleInput(data);
        break;
      case "actions":
        mode.menu.handleInput(data);
        break;
      case "confirm": {
        const keys = getKeybindings();
        if (keys.matches(data, "tui.select.confirm"))
          void this.#save(
            this.#options.entries().filter((_entry, index) => index !== mode.index),
            mode.index,
          );
        else if (keys.matches(data, "tui.select.cancel")) this.#showList(mode.index);
        break;
      }
      case "form":
        if (mode.choices) mode.choices.handleInput(data);
        else mode.input?.handleInput(data);
        break;
    }
    this.#options.requestRender();
  }

  #renderMode(width: number): string[] {
    const { theme } = this.#options;
    const mode = this.#mode;
    switch (mode.kind) {
      case "list": {
        const empty =
          this.#options.entries().length === 0 ? paragraph(theme.fg("dim", this.#options.emptyText), width) : [];
        return [...empty, ...this.#list.render(width), "", hint(theme, "Enter to choose · Esc to go back", width)];
      }
      case "actions": {
        const entry = this.#options.entries()[mode.index];
        const label = entry === undefined ? "" : this.#options.describe(entry).label;
        return [truncateToWidth(` ${label}`, width), ...mode.menu.render(width)];
      }
      case "confirm": {
        const entry = this.#options.entries()[mode.index];
        const label = entry === undefined ? "" : this.#options.describe(entry).label;
        return [...paragraph(`Remove ${label}?`, width), hint(theme, "Enter removes it · Esc keeps it", width)];
      }
      case "form": {
        const fields = this.#options.fields();
        const field = fields[mode.step];
        const heading = `${mode.index === undefined ? "Add" : "Edit"} · ${field?.label ?? ""} (${mode.step + 1}/${fields.length})`;
        const body = mode.choices ? mode.choices.render(width) : (mode.input?.render(width) ?? []);
        const keys = mode.choices ? "Enter to choose · Esc to cancel" : "Enter to continue · Esc to cancel";
        return [truncateToWidth(` ${theme.fg("accent", heading)}`, width), ...body, hint(theme, keys, width)];
      }
    }
  }

  render(width: number): string[] {
    const { theme } = this.#options;
    return [
      title(theme, this.#options.heading, width),
      ...paragraph(theme.fg("muted", this.#options.intro), width),
      "",
      ...this.#renderMode(width),
      ...(this.#message ? ["", ...messageLines(theme, this.#message, width)] : []),
    ];
  }

  invalidate(): void {
    this.#list.invalidate();
  }
}
