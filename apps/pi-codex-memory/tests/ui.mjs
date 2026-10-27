import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** A row's label without Pi's "✓ " mark or the two spaces that align unmarked rows. */
const unmarked = (text) => text.replace(/^(✓ | {2})/, "");

/**
 * Finds a row of Pi's plain selector by its label. Option rows read "Label — description";
 * settings rows read "Label: value". An undefined label cancels.
 */
export function pickRow(rows, label) {
    if (label === undefined) return undefined;
    const row = rows.find((text) => {
        const plain = unmarked(text);
        return (
            plain === label ||
            plain.startsWith(`${label} — `) ||
            plain.startsWith(`${label}: `)
        );
    });
    if (!row) throw new Error(`No row "${label}" in ${JSON.stringify(rows)}`);
    return row;
}

const plainTheme = { fg: (_color, text) => text, bold: (text) => text };
const tick = () => new Promise((resolve) => setImmediate(resolve));
let isThemeReady = false;

/**
 * A `ctx.ui.custom` that drives the extension's terminal panels with keys. Steps run in order,
 * across panels: a label moves the cursor to that row and presses Enter, `{ search, pick }` types
 * the search first, and undefined presses Esc. A panel that stays open after Enter, such as a
 * settings page that cycled a value or opened a list, takes the next step. Before each step the
 * panel's text is added to `screens`.
 */
export function terminalPicker(steps, screens = []) {
    if (!isThemeReady) {
        initTheme();
        isThemeReady = true;
    }
    const render = (panel) =>
        panel.render(160).map((line) => stripTerminalSequences(line));
    const press = (panel, step) => {
        if (step === undefined) {
            panel.handleInput("\x1b");
            return;
        }
        const { search = "", pick: label } =
            typeof step === "string" ? { pick: step } : step;
        for (const character of search) panel.handleInput(character);
        for (let move = 0; move < 50; move++) {
            const cursor = render(panel).find((line) =>
                line.trimStart().startsWith("→ "),
            );
            const text = cursor && unmarked(cursor.trimStart().slice(2));
            if (text?.startsWith(label)) {
                panel.handleInput("\r");
                return;
            }
            panel.handleInput("\x1b[B");
        }
        throw new Error(`No row "${label}" in the panel`);
    };
    return (factory) =>
        new Promise((resolve, reject) => {
            let isDone = false;
            const panel = factory(
                { requestRender() {} },
                plainTheme,
                undefined,
                (value) => {
                    isDone = true;
                    resolve(value);
                },
            );
            void (async () => {
                while (!isDone) {
                    screens.push(render(panel).join("\n"));
                    const step = steps.shift();
                    press(panel, step);
                    // Saves and dialogs settle before the panel closes.
                    for (let wait = 0; wait < 50 && !isDone; wait++)
                        await tick();
                    if (step === undefined && !steps.length) return;
                }
            })().catch(reject);
        });
}
