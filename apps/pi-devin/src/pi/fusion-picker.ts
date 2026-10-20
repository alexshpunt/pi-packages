import type { Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, fuzzyFilter, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { FusionChoices, FusionSelection } from "./models.ts";

export type PickerTheme = Pick<Theme, "fg" | "bold">;
interface Item { id: string; name: string; recommended?: true }

const VISIBLE_ROWS = 10;
/** Below this width, only the focused column is drawn instead of two side by side. */
const MIN_TWO_COLUMN_WIDTH = 60;
const SEPARATOR = " │ ";
const HELP = "tab switch column · ↑↓ move · type to search · ↵ save · esc cancel";

class PickerColumn {
  readonly title: string;
  readonly currentID: string | undefined;
  readonly items: Item[];
  query = "";
  selectedID: string | undefined;
  private offset = 0;

  constructor(title: string, items: readonly Item[], currentID: string | undefined) {
    this.title = title;
    this.currentID = currentID;
    // Recommended items come first; catalog order is kept within each group.
    this.items = [...items.filter((item) => item.recommended), ...items.filter((item) => !item.recommended)];
    this.selectedID = (this.items.find((item) => item.id === currentID) ?? this.items[0])?.id;
  }

  visible(): Item[] {
    return this.query.trim() ? fuzzyFilter(this.items, this.query.trim(), (item) => `${item.name} ${item.id}`) : this.items;
  }

  selected(): Item | undefined {
    return this.visible().find((item) => item.id === this.selectedID);
  }

  /** If the search hides the selected item, the selection moves to the first match. */
  setQuery(query: string): void {
    this.query = query;
    const visible = this.visible();
    if (!visible.some((item) => item.id === this.selectedID)) this.selectedID = visible[0]?.id ?? this.selectedID;
    this.offset = 0;
  }

  move(delta: number): void {
    const visible = this.visible();
    if (!visible.length) return;
    const index = Math.max(0, visible.findIndex((item) => item.id === this.selectedID));
    const next = Math.abs(delta) === 1 ? (index + delta + visible.length) % visible.length : Math.min(visible.length - 1, Math.max(0, index + delta));
    this.selectedID = visible[next].id;
  }

  /** Scrolls so the selected item is visible, then returns the visible rows. */
  rows(count: number): { items: Item[]; total: number } {
    const visible = this.visible();
    const index = visible.findIndex((item) => item.id === this.selectedID);
    if (index >= 0 && index < this.offset) this.offset = index;
    if (index >= this.offset + count) this.offset = index - count + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, visible.length - count)));
    return { items: visible.slice(this.offset, this.offset + count), total: visible.length };
  }
}

export interface FusionPickerOptions {
  choices: FusionChoices;
  current: FusionSelection | undefined;
  theme: PickerTheme;
  requestRender: () => void;
  done: (selection: FusionSelection | undefined) => void;
}

/** TUI picker for `/devin-fusion`. Choose the lead and sidekick columns on one screen and save both with Enter. */
export class FusionPicker {
  private readonly columns: [PickerColumn, PickerColumn];
  private focus: 0 | 1 = 0;
  private notice: string | undefined;
  private cached: { width: number; lines: string[] } | undefined;
  private readonly options: FusionPickerOptions;

  constructor(options: FusionPickerOptions) {
    this.options = options;
    this.columns = [
      new PickerColumn("LEAD", options.choices.leads, options.current?.leadID),
      new PickerColumn("SIDEKICK", options.choices.sidekicks, options.current?.sidekickID),
    ];
  }

  invalidate(): void { this.cached = undefined; }

  private changed(): void { this.invalidate(); this.options.requestRender(); }

  handleInput(data: string): void {
    const column = this.columns[this.focus];
    this.notice = undefined;
    if (matchesKey(data, "ctrl+c")) return this.options.done(undefined);
    if (matchesKey(data, "escape")) {
      // While searching, the first esc only clears the search.
      if (column.query) { column.setQuery(""); return this.changed(); }
      return this.options.done(undefined);
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
      this.focus = this.focus === 0 ? 1 : 0;
      return this.changed();
    }
    if (matchesKey(data, "up")) { column.move(-1); return this.changed(); }
    if (matchesKey(data, "down")) { column.move(1); return this.changed(); }
    if (matchesKey(data, "pageUp")) { column.move(-VISIBLE_ROWS); return this.changed(); }
    if (matchesKey(data, "pageDown")) { column.move(VISIBLE_ROWS); return this.changed(); }
    if (matchesKey(data, "enter")) {
      const [lead, sidekick] = this.columns.map((item) => item.selected());
      if (lead && sidekick) return this.options.done({ leadID: lead.id, sidekickID: sidekick.id });
      this.notice = `Pick a model in the ${lead ? "sidekick" : "lead"} column. Press esc to clear the search.`;
      return this.changed();
    }
    if (matchesKey(data, "backspace")) {
      if (column.query) { column.setQuery(column.query.slice(0, -1)); this.changed(); }
      return;
    }
    // The Kitty keyboard protocol sends characters as CSI-u sequences. Other input counts as text only when it has no control characters.
    const text = decodeKittyPrintable(data) ?? (/^[^\p{Cc}]+$/u.test(data) ? data : undefined);
    if (text) { column.setQuery(column.query + text); this.changed(); }
  }

  render(width: number): string[] {
    if (this.cached?.width === width) return this.cached.lines;
    const { theme } = this.options;
    const name = (column: PickerColumn, id: string | undefined) => column.items.find((item) => item.id === id)?.name ?? "none";
    const lines = [
      theme.fg("accent", theme.bold("Devin Fusion")) + theme.fg("muted", " · choose the lead and sidekick on one screen"),
      theme.fg("muted", `Current: ${this.options.current ? `${name(this.columns[0], this.options.current.leadID)} + ${name(this.columns[1], this.options.current.sidekickID)}` : "no saved pair"}`),
      "",
    ];
    if (width >= MIN_TWO_COLUMN_WIDTH) {
      const columnWidth = Math.floor((width - SEPARATOR.length) / 2);
      const [left, right] = this.columns.map((column, index) => this.renderColumn(column, index === this.focus, columnWidth));
      const separator = theme.fg("borderMuted", SEPARATOR);
      for (let index = 0; index < left.length; index++) lines.push(left[index] + separator + right[index]);
    } else {
      const tabs = this.columns.map((column, index) => index === this.focus ? theme.fg("accent", theme.bold(`[${column.title}]`)) : theme.fg("muted", column.title)).join(" ");
      lines.push(tabs, ...this.renderColumn(this.columns[this.focus], true, width));
    }
    const [lead, sidekick] = this.columns.map((column) => column.selected()?.name ?? "—");
    lines.push("", theme.fg("accent", `Selected: ${lead} + ${sidekick}`), this.notice ? theme.fg("warning", this.notice) : theme.fg("dim", HELP));
    const result = lines.map((line) => truncateToWidth(line, width));
    this.cached = { width, lines: result };
    return result;
  }

  private renderColumn(column: PickerColumn, isFocused: boolean, width: number): string[] {
    const { theme } = this.options;
    const { items, total } = column.rows(VISIBLE_ROWS);
    const count = `${total}/${column.items.length}`;
    const query = column.query ? ` search: ${column.query}${isFocused ? "▏" : ""}` : isFocused ? " (type to search)" : "";
    const header = truncateToWidth(`${isFocused ? "▸ " : "  "}${column.title} ${count}${query}`, width, "…", true);
    const lines = [isFocused ? theme.fg("accent", theme.bold(header)) : theme.fg("muted", header)];
    for (let index = 0; index < VISIBLE_ROWS; index++) {
      const item = items[index];
      if (!item) {
        const empty = index === 0 && total === 0 ? "  no matching models" : "";
        lines.push(theme.fg("dim", truncateToWidth(empty, width, "…", true)));
        continue;
      }
      const isSelected = item.id === column.selectedID;
      const marks = `${isSelected ? "›" : " "}${item.id === column.currentID ? "●" : " "}${item.recommended ? "★" : " "} `;
      const cell = truncateToWidth(marks + item.name, width, "…", true);
      lines.push(isSelected && isFocused ? theme.fg("accent", theme.bold(cell)) : isSelected ? cell : theme.fg("muted", cell));
    }
    return lines;
  }
}
