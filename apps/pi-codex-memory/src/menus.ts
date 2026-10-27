import {
    type ExtensionContext,
    getSelectListTheme,
    getSettingsListTheme,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Container,
    type Focusable,
    fuzzyFilter,
    getKeybindings,
    Input,
    type SelectItem,
    SelectList,
    type SelectListLayoutOptions,
    type SettingItem,
    SettingsList,
    Spacer,
    Text,
} from "@earendil-works/pi-tui";

/** One row of an option list. */
export interface Option {
    readonly value: string;
    readonly label: string;
    /** Muted text after the label, as Pi shows a model's `[provider]`. */
    readonly hint?: string;
    readonly description?: string;
    /** Extra text that the filter matches, such as a memory's body. */
    readonly searchText?: string;
}
export interface OptionListSettings {
    /** Highlighted when the list opens. */
    readonly preselect?: string;
    readonly isSearchable?: boolean;
    /** Filter text the list opens with, such as the search before an item was opened. */
    readonly query?: string;
    readonly layout?: SelectListLayoutOptions;
}
/** One row of a settings page. */
export interface SettingRow {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly description: string;
    /** Values that Enter and Space cycle through, as in Pi's /settings. */
    readonly values?: readonly string[];
    /** Saves a cycled value while the page stays open; every row then shows the saved state. */
    readonly apply?: (value: string) => Promise<void>;
    /** Opens an option list in place, as Pi's /settings does for a model. */
    readonly options?: () => {
        readonly title: string;
        readonly description?: string;
        readonly options: readonly Option[];
    } & OptionListSettings;
}
/**
 * A row the user activated or a value they picked; the caller handles it and opens the page again.
 * `value` is undefined when a plain selector's value list was cancelled.
 */
export interface SettingChoice {
    readonly id: string;
    readonly value?: string;
    /** The filter text of the option list the value was picked from. */
    readonly query?: string;
}

/** The size Pi gives its settings submenus. */
const OPTION_LAYOUT: SelectListLayoutOptions = {
    minPrimaryColumnWidth: 12,
    maxPrimaryColumnWidth: 32,
};
const MAX_VISIBLE_OPTIONS = 10;
const MAX_VISIBLE_SETTINGS = 10;

/** RPC clients show dialogs but not terminal components. */
function hasTerminal(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && ctx.hasUI;
}

/** Pi's settings submenu: title, description, optional filter, list and key hint. */
class OptionList extends Container implements Focusable {
    readonly #theme: Theme;
    readonly #options: readonly Option[];
    readonly #settings: OptionListSettings;
    readonly #onSelect: (value: string) => void;
    readonly #onCancel: () => void;
    readonly #search: Input | undefined;
    readonly #listIndex: number;
    #list: SelectList;
    #isFocused = false;

    constructor(
        theme: Theme,
        title: string,
        description: string | undefined,
        options: readonly Option[],
        settings: OptionListSettings,
        onSelect: (value: string) => void,
        onCancel: () => void,
    ) {
        super();
        this.#theme = theme;
        this.#options = options;
        this.#settings = settings;
        this.#onSelect = onSelect;
        this.#onCancel = onCancel;
        this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
        if (description) {
            this.addChild(new Spacer(1));
            this.addChild(new Text(theme.fg("muted", description), 0, 0));
        }
        if (settings.isSearchable) {
            this.addChild(new Spacer(1));
            this.#search = new Input();
            this.#search.onSubmit = () => this.#list.handleInput("\r");
            this.addChild(this.#search);
        }
        this.addChild(new Spacer(1));
        // Pasted rather than set, so the cursor ends after the text and typing continues it.
        if (this.#search && settings.query)
            this.#search.handleInput(`\x1b[200~${settings.query}\x1b[201~`);
        this.#list = this.#buildList(
            this.#filter(this.query),
            settings.preselect,
        );
        this.#listIndex = this.children.length;
        this.addChild(this.#list);
        this.addChild(new Spacer(1));
        this.addChild(
            new Text(
                theme.fg(
                    "dim",
                    settings.isSearchable
                        ? "  Type to filter · Enter to select · Esc to go back"
                        : "  Enter to select · Esc to go back",
                ),
                0,
                0,
            ),
        );
    }
    get focused(): boolean {
        return this.#isFocused;
    }
    set focused(value: boolean) {
        this.#isFocused = value;
        if (this.#search) this.#search.focused = value;
    }
    get query(): string {
        return this.#search?.getValue() ?? "";
    }
    #filter(query: string): readonly Option[] {
        return query
            ? fuzzyFilter(
                  [...this.#options],
                  query,
                  (option) =>
                      `${option.label} ${option.hint ?? ""} ${option.description ?? ""} ${option.searchText ?? ""}`,
              )
            : this.#options;
    }
    #buildList(options: readonly Option[], preselect: string | undefined) {
        const items: SelectItem[] = options.map(
            ({ value, label, hint, description }) => ({
                value,
                label: hint
                    ? `${label} ${this.#theme.fg("muted", hint)}`
                    : label,
                description,
            }),
        );
        const list = new SelectList(
            items,
            Math.min(Math.max(items.length, 1), MAX_VISIBLE_OPTIONS),
            getSelectListTheme(),
            this.#settings.layout ?? OPTION_LAYOUT,
        );
        const index = items.findIndex((item) => item.value === preselect);
        if (index >= 0) list.setSelectedIndex(index);
        list.onSelect = (item) => this.#onSelect(item.value);
        list.onCancel = () => this.#onCancel();
        return list;
    }
    handleInput(data: string): void {
        const keys = getKeybindings();
        if (
            !this.#search ||
            keys.matches(data, "tui.select.up") ||
            keys.matches(data, "tui.select.down") ||
            keys.matches(data, "tui.select.confirm") ||
            keys.matches(data, "tui.select.cancel")
        ) {
            this.#list.handleInput(data);
            return;
        }
        this.#search.handleInput(data);
        this.#list = this.#buildList(
            this.#filter(this.query),
            this.#settings.preselect,
        );
        this.children[this.#listIndex] = this.#list;
    }
}

/** A row without values reports Enter to the caller: one value cycles to itself. */
function rowValues(row: SettingRow): string[] | undefined {
    if (row.values) return [...row.values];
    return row.options ? undefined : [row.value];
}
/** Pi's settings page: borders around a SettingsList that explains the highlighted row. */
class SettingsPage implements Component, Focusable {
    readonly #theme: Theme;
    readonly #isSearchable: boolean;
    #list: SettingsList;
    #items: readonly SettingItem[];
    readonly #getRows: () => readonly SettingRow[];
    #rows: readonly SettingRow[];
    readonly #done: (choice: SettingChoice | undefined) => void;
    readonly #requestRender: () => void;
    /** In-place saves run one at a time, and the page closes only after the last one. */
    #saving: Promise<void> = Promise.resolve();
    #isFocused = false;
    /** The open option list, which receives focus so its filter shows the cursor and IME input. */
    #submenuList: OptionList | undefined;
    /** The filter text of the option list a value was last picked from. */
    #submenuQuery = "";

    constructor(
        theme: Theme,
        getRows: () => readonly SettingRow[],
        selectedId: string | undefined,
        isSearchable: boolean,
        requestRender: () => void,
        done: (choice: SettingChoice | undefined) => void,
    ) {
        this.#theme = theme;
        this.#isSearchable = isSearchable;
        this.#getRows = getRows;
        this.#rows = getRows();
        this.#done = done;
        this.#requestRender = requestRender;
        [this.#items, this.#list] = this.#build(selectedId);
    }
    #build(
        selectedId: string | undefined,
    ): [readonly SettingItem[], SettingsList] {
        const items: SettingItem[] = this.#rows.map((row) => ({
            id: row.id,
            label: row.label,
            currentValue: row.value,
            description: row.description,
            values: rowValues(row),
            ...(row.options ? { submenu: this.#submenu(row) } : {}),
        }));
        const list = new SettingsList(
            items,
            Math.min(items.length, MAX_VISIBLE_SETTINGS),
            getSettingsListTheme(),
            (id, value) => this.#change(id, value),
            () => this.#close(undefined),
            { enableSearch: this.#isSearchable },
        );
        if (selectedId) list.selectItem(selectedId);
        return [items, list];
    }
    get focused(): boolean {
        return this.#isFocused;
    }
    set focused(value: boolean) {
        this.#isFocused = value;
        if (this.#submenuList) this.#submenuList.focused = value;
    }
    #submenu(row: SettingRow): NonNullable<SettingItem["submenu"]> {
        return (_value, done) => {
            const { title, description, options, ...settings } = row.options!();
            const close = (value?: string) => {
                this.#submenuQuery = list.query;
                this.#submenuList = undefined;
                done(value);
            };
            const list = new OptionList(
                this.#theme,
                title,
                description,
                options,
                settings,
                (value) => close(value),
                () => close(),
            );
            list.focused = this.#isFocused;
            this.#submenuList = list;
            return list;
        };
    }
    #change(id: string, value: string): void {
        const row = this.#rows.find((item) => item.id === id);
        if (!row?.apply) {
            // SettingsList shows a picked option as the row's value; the page closes with the
            // row as it was, not a memory's path.
            if (row) this.#list.updateValue(id, row.value);
            this.#close({
                id,
                value,
                ...(row?.options && this.#submenuQuery
                    ? { query: this.#submenuQuery }
                    : {}),
            });
            return;
        }
        this.#saving = this.#saving.then(async () => {
            await row.apply!(value);
            this.#refresh(id);
            this.#requestRender();
        });
    }
    /**
     * A saved value can change other rows, such as a description that names the idle time, or
     * which rows exist, such as a job that the save stopped. The list is rebuilt on the saved row then.
     */
    #refresh(selectedId: string): void {
        this.#rows = this.#getRows();
        const isSameRows =
            this.#rows.length === this.#items.length &&
            this.#rows.every((row, index) => row.id === this.#items[index]?.id);
        if (!isSameRows && !this.#submenuList) {
            [this.#items, this.#list] = this.#build(selectedId);
            return;
        }
        for (const row of this.#rows) {
            const item = this.#items.find((entry) => entry.id === row.id);
            if (!item) continue;
            item.currentValue = row.value;
            item.description = row.description;
            item.values = rowValues(row);
        }
    }
    #close(choice: SettingChoice | undefined): void {
        void this.#saving.then(() => this.#done(choice));
    }
    handleInput(data: string): void {
        this.#list.handleInput(data);
    }
    render(width: number): string[] {
        const border = this.#theme.fg("border", "─".repeat(Math.max(1, width)));
        return [border, ...this.#list.render(width), border];
    }
    invalidate(): void {
        this.#list.invalidate();
    }
}

/** Shows an option list on its own, framed as in Pi's /settings. Esc returns undefined. */
export async function pickOption(
    ctx: ExtensionContext,
    title: string,
    description: string | undefined,
    options: readonly Option[],
    settings: OptionListSettings & { readonly signal?: AbortSignal } = {},
): Promise<string | undefined> {
    return (
        await pickOptionWithQuery(ctx, title, description, options, settings)
    )?.value;
}
/** Like pickOption, and also returns the filter text so the list can reopen with it. */
export async function pickOptionWithQuery(
    ctx: ExtensionContext,
    title: string,
    description: string | undefined,
    options: readonly Option[],
    settings: OptionListSettings & { readonly signal?: AbortSignal } = {},
): Promise<{ value: string; query: string } | undefined> {
    const { signal } = settings;
    if (!ctx.hasUI || !options.length || signal?.aborted) return undefined;
    if (!hasTerminal(ctx)) {
        const rows = options.map((option) => {
            const label = option.hint
                ? `${option.label} ${option.hint}`
                : option.label;
            return option.description
                ? `${label} — ${option.description}`
                : label;
        });
        const picked = await ctx.ui.select(
            [title, description].filter(Boolean).join("\n"),
            rows,
            { signal },
        );
        const value = options[rows.indexOf(picked ?? "")]?.value;
        return value === undefined ? undefined : { value, query: "" };
    }
    let stop: (() => void) | undefined;
    try {
        return await ctx.ui.custom<
            { value: string; query: string } | undefined
        >((_tui, theme, _keys, done) => {
            stop = () => done(undefined);
            signal?.addEventListener("abort", stop, { once: true });
            const list: OptionList = new OptionList(
                theme,
                title,
                description,
                options,
                settings,
                (value) => done({ value, query: list.query }),
                () => done(undefined),
            );
            const border = (width: number) =>
                theme.fg("border", "─".repeat(Math.max(1, width)));
            return {
                get focused() {
                    return list.focused;
                },
                set focused(value: boolean) {
                    list.focused = value;
                },
                handleInput: (data: string) => list.handleInput(data),
                render: (width: number) => [
                    border(width),
                    ...list.render(width),
                    border(width),
                ],
                invalidate: () => list.invalidate(),
            };
        });
    } finally {
        if (stop) signal?.removeEventListener("abort", stop);
    }
}

/**
 * Shows a settings page. Cycled rows with `apply` save in place; any other change or activated
 * row closes the page and is returned. Esc returns undefined.
 */
export async function openSettings(
    ctx: ExtensionContext,
    title: string,
    getRows: () => readonly SettingRow[],
    options: {
        readonly selectedId?: string;
        readonly isSearchable?: boolean;
    } = {},
): Promise<SettingChoice | undefined> {
    if (!ctx.hasUI) return undefined;
    if (hasTerminal(ctx))
        return ctx.ui.custom<SettingChoice | undefined>(
            (tui, theme, _keys, done) =>
                new SettingsPage(
                    theme,
                    getRows,
                    options.selectedId,
                    options.isSearchable ?? false,
                    () => tui.requestRender(),
                    done,
                ),
        );
    const rows = getRows();
    const labels = rows.map((row) =>
        row.value ? `${row.label}: ${row.value}` : row.label,
    );
    const row =
        rows[labels.indexOf((await ctx.ui.select(title, labels)) ?? "")];
    if (!row) return undefined;
    if (row.values) {
        const value = await ctx.ui.select(row.label, [...row.values]);
        if (value !== undefined && row.apply) await row.apply(value);
        return { id: row.id, value };
    }
    if (row.options) {
        const {
            title: listTitle,
            description,
            options: list,
            ...settings
        } = row.options();
        return {
            id: row.id,
            value: await pickOption(
                ctx,
                listTitle,
                description,
                list,
                settings,
            ),
        };
    }
    return { id: row.id, value: row.value };
}
