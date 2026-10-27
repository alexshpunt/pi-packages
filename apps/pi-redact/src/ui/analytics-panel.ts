import { basename } from "node:path";
import { getSelectListTheme, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  matchesKey,
  type SelectItem,
  SelectList,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  ANALYTICS_RETENTION_DAYS,
  type AnalyticsReader,
  type AnalyticsScope,
  type AnalyticsSummary,
  type RecordSummary,
  type StoredRecord,
} from "../analytics.js";
import { type Excerpt, excerptDiffText } from "../excerpt.js";
import { errorText } from "../notify.js";
import { hint, messageLines, type PanelMessage, paragraph, title } from "./common.js";

export interface AnalyticsPanelOptions {
  readonly theme: Theme;
  readonly sessionId: string;
  readonly reader: AnalyticsReader;
  /** Terminal height, to size the scrolling view of a record. */
  rows(): number;
  requestRender(): void;
  onClose(): void;
}

/** The newest records listed; the summary still counts every record in scope. */
const MAX_LISTED_RECORDS = 500;
const MAX_VISIBLE_RECORDS = 12;
const TAB_SPACES = "   ";

type ScopeKind = "session" | "all";
type ViewKind = "diff" | "split";

type Mode =
  | { readonly kind: "list" }
  | { readonly kind: "confirm" }
  | { readonly kind: "detail"; readonly record: StoredRecord; view: ViewKind; offset: number };

const pad = (value: number) => String(value).padStart(2, "0");

function timeOf(ms: number, isLong: boolean): string {
  const date = new Date(ms);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return isLong ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}` : time;
}

function shortDateOf(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function commonPrefixLength(left: string, right: string): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length++;
  return length;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  let length = 0;
  const limit = Math.min(left.length, right.length) - prefixLength;
  while (length < limit && left[left.length - 1 - length] === right[right.length - 1 - length]) length++;
  return length;
}

/**
 * `/redact-analytics`: records of what pi-redact masked, newest first, and each record's
 * original and masked lines as a diff or as separate before and after views.
 */
export class AnalyticsPanel implements Component {
  readonly #options: AnalyticsPanelOptions;
  #scopeKind: ScopeKind = "session";
  #records: readonly RecordSummary[] = [];
  #summary: AnalyticsSummary = { records: 0, changedLines: 0, rules: [] };
  #list: SelectList;
  #mode: Mode = { kind: "list" };
  #message: PanelMessage | undefined;
  #isClosed = false;
  #body: { readonly key: string; readonly lines: readonly string[] } | undefined;

  constructor(options: AnalyticsPanelOptions) {
    this.#options = options;
    this.#list = this.#load();
  }

  #scope(): AnalyticsScope {
    return this.#scopeKind === "session" ? { sessionId: this.#options.sessionId } : {};
  }

  /** Read the records in scope and build their list; storage errors leave an empty list and a message. */
  #load(selectedIndex = 0): SelectList {
    try {
      this.#records = this.#options.reader.list(this.#scope(), MAX_LISTED_RECORDS);
      this.#summary = this.#options.reader.summarize(this.#scope());
    } catch (error) {
      this.#records = [];
      this.#summary = { records: 0, changedLines: 0, rules: [] };
      this.#message = { text: `The analytics file could not be read: ${errorText(error)}`, isError: true };
    }
    const isAll = this.#scopeKind === "all";
    const items: SelectItem[] = this.#records.map((record) => ({
      value: String(record.id),
      label: `${isAll ? shortDateOf(record.recordedAtMs) : timeOf(record.recordedAtMs, false)}  ${record.label}`,
      description: [record.source, record.ruleIds.join(", "), isAll ? basename(record.cwd) : ""]
        .filter(Boolean)
        .join(" · "),
    }));
    const list = new SelectList(items, Math.min(Math.max(items.length, 1), MAX_VISIBLE_RECORDS), getSelectListTheme());
    if (items.length) list.setSelectedIndex(Math.min(selectedIndex, items.length - 1));
    list.onSelect = (item) => this.#open(Number(item.value));
    list.onCancel = () => this.#close();
    return list;
  }

  #open(id: number): void {
    try {
      const record = this.#options.reader.get(id);
      if (!record) {
        this.#message = { text: "This record no longer exists.", isError: true };
        this.#list = this.#load();
        return;
      }
      this.#message = undefined;
      this.#body = undefined;
      this.#mode = { kind: "detail", record, view: "diff", offset: 0 };
    } catch (error) {
      this.#message = { text: errorText(error), isError: true };
    }
  }

  #clear(): void {
    try {
      const count = this.#options.reader.clear(this.#scope());
      this.#message = { text: `Deleted ${count} records.`, isError: false };
    } catch (error) {
      this.#message = { text: errorText(error), isError: true };
    }
    this.#mode = { kind: "list" };
    this.#list = this.#load();
  }

  #close(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#options.onClose();
  }

  #bodyHeight(): number {
    return Math.max(6, this.#options.rows() - 12);
  }

  handleInput(data: string): void {
    if (this.#isClosed) return;
    const keys = getKeybindings();
    const mode = this.#mode;
    if (mode.kind === "confirm") {
      if (keys.matches(data, "tui.select.confirm")) this.#clear();
      else if (keys.matches(data, "tui.select.cancel")) this.#mode = { kind: "list" };
    } else if (mode.kind === "detail") {
      const page = this.#bodyHeight();
      if (keys.matches(data, "tui.select.cancel")) this.#mode = { kind: "list" };
      else if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
        mode.view = mode.view === "diff" ? "split" : "diff";
        mode.offset = 0;
      } else if (keys.matches(data, "tui.select.up")) mode.offset = Math.max(0, mode.offset - 1);
      else if (keys.matches(data, "tui.select.down")) mode.offset++;
      else if (keys.matches(data, "tui.select.pageUp")) mode.offset = Math.max(0, mode.offset - page);
      else if (keys.matches(data, "tui.select.pageDown")) mode.offset += page;
    } else if (matchesKey(data, "tab")) {
      this.#scopeKind = this.#scopeKind === "session" ? "all" : "session";
      this.#message = undefined;
      this.#list = this.#load();
    } else if (data === "d" || matchesKey(data, "delete")) {
      if (this.#summary.records > 0) this.#mode = { kind: "confirm" };
    } else {
      this.#list.handleInput(data);
    }
    this.#options.requestRender();
  }

  #scopeLine(width: number): string {
    const { theme } = this.#options;
    const session = this.#scopeKind === "session" ? theme.fg("accent", "[This session]") : "This session";
    const all =
      this.#scopeKind === "all"
        ? theme.fg("accent", `[All sessions, last ${ANALYTICS_RETENTION_DAYS} days]`)
        : `All sessions, last ${ANALYTICS_RETENTION_DAYS} days`;
    return truncateToWidth(` ${session}  ${all}`, width);
  }

  #renderList(width: number): string[] {
    const { theme } = this.#options;
    const summary = this.#summary;
    const lines = [this.#scopeLine(width), ""];
    if (summary.records === 0) {
      const empty =
        this.#scopeKind === "session"
          ? "Nothing has been masked in this session yet."
          : `Nothing was masked in the last ${ANALYTICS_RETENTION_DAYS} days.`;
      lines.push(...paragraph(theme.fg("muted", empty), width));
    } else {
      const rules = summary.rules.map(([ruleId, count]) => `${ruleId} ${count}`).join(" · ");
      lines.push(
        ...paragraph(
          theme.fg("muted", `${summary.records} records, ${summary.changedLines} masked lines. Rules: ${rules}`),
          width,
        ),
      );
      if (summary.records > this.#records.length)
        lines.push(...paragraph(theme.fg("dim", `Showing the newest ${this.#records.length}.`), width));
      lines.push("", ...this.#list.render(width));
    }
    if (this.#mode.kind === "confirm") {
      const what =
        this.#scopeKind === "session"
          ? `the ${summary.records} records of this session`
          : `all ${summary.records} records of the last ${ANALYTICS_RETENTION_DAYS} days`;
      lines.push("", ...paragraph(theme.fg("warning", `Delete ${what}?`), width));
      lines.push(hint(theme, "Enter deletes them · Esc keeps them", width));
    } else {
      lines.push("", hint(theme, "↑↓ select · Enter view · Tab switch scope · d delete records · Esc close", width));
    }
    return lines;
  }

  #diffLines(excerpt: Excerpt, width: number): string[] {
    const rendered = renderDiff(excerptDiffText(excerpt));
    return rendered.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  }

  /** The original lines, then the masked lines, with the changed part of each changed line highlighted. */
  #splitLines(excerpt: Excerpt, width: number): string[] {
    const { theme } = this.#options;
    const numberWidth = String(Math.max(1, ...excerpt.lines.map((line) => line?.line ?? 1))).length;
    const section = (heading: string, side: "before" | "after") => {
      const color = side === "before" ? "toolDiffRemoved" : "toolDiffAdded";
      const output = [theme.fg("accent", ` ${heading}`)];
      for (const line of excerpt.lines) {
        if (line === null) {
          output.push(theme.fg("toolDiffContext", ` ${" ".repeat(numberWidth)} ...`));
          continue;
        }
        const number = String(line.line).padStart(numberWidth, " ");
        const text = (side === "before" ? line.before : (line.after ?? line.before)).replaceAll("\t", TAB_SPACES);
        if (line.after === undefined) {
          output.push(theme.fg("toolDiffContext", ` ${number} ${text}`));
          continue;
        }
        const other = (side === "before" ? line.after : line.before).replaceAll("\t", TAB_SPACES);
        const prefix = commonPrefixLength(text, other);
        const suffix = commonSuffixLength(text, other, prefix);
        const changed = text.slice(prefix, text.length - suffix);
        output.push(
          theme.fg(
            color,
            ` ${number} ${text.slice(0, prefix)}${theme.inverse(changed)}${text.slice(text.length - suffix)}`,
          ),
        );
      }
      return output;
    };
    return [...section("Before", "before"), "", ...section("After", "after")].flatMap((line) =>
      wrapTextWithAnsi(line, Math.max(1, width)),
    );
  }

  #renderDetail(mode: Extract<Mode, { kind: "detail" }>, width: number): string[] {
    const { theme } = this.#options;
    const { record } = mode;
    const lines = [
      truncateToWidth(` ${theme.fg("accent", theme.bold(record.label))}`, width),
      ...paragraph(theme.fg("muted", `${record.source} · ${timeOf(record.recordedAtMs, true)} · ${record.cwd}`), width),
      ...paragraph(
        theme.fg("muted", `Rules: ${record.ruleIds.join(", ") || "unknown"} · ${record.changedLines} masked lines`),
        width,
      ),
    ];
    const diff = mode.view === "diff" ? theme.fg("accent", "[Diff]") : "Diff";
    const split = mode.view === "split" ? theme.fg("accent", "[Before / After]") : "Before / After";
    lines.push(truncateToWidth(` ${diff}  ${split}`, width), "");
    const excerpt = record.excerpt;
    if (!excerpt) return [...lines, ...paragraph(theme.fg("error", "This record cannot be shown."), width)];

    const key = `${record.id}:${mode.view}:${width}`;
    if (this.#body?.key !== key)
      this.#body = {
        key,
        lines: mode.view === "diff" ? this.#diffLines(excerpt, width) : this.#splitLines(excerpt, width),
      };
    const body = this.#body.lines;
    const height = this.#bodyHeight();
    mode.offset = Math.min(mode.offset, Math.max(0, body.length - height));
    lines.push(...body.slice(mode.offset, mode.offset + height));
    if (body.length > height)
      lines.push(
        theme.fg("dim", `  lines ${mode.offset + 1}–${Math.min(mode.offset + height, body.length)} of ${body.length}`),
      );
    if (excerpt.isTruncated)
      lines.push(...paragraph(theme.fg("dim", "Only the first changes were stored for this record."), width));
    lines.push("", hint(theme, "↑↓ scroll · PgUp/PgDn page · Tab diff or before/after · Esc back", width));
    return lines;
  }

  render(width: number): string[] {
    const { theme } = this.#options;
    const mode = this.#mode;
    return [
      title(theme, "Redact · Analytics", width),
      "",
      ...(mode.kind === "detail" ? this.#renderDetail(mode, width) : this.#renderList(width)),
      ...(this.#message ? ["", ...messageLines(theme, this.#message, width)] : []),
    ];
  }

  invalidate(): void {
    this.#body = undefined;
    this.#list.invalidate();
  }

  dispose(): void {
    this.#isClosed = true;
  }
}
