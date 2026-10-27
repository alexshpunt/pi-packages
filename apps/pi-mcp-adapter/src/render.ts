/**
 * Transcript rendering of MCP tool calls and results, the same way pi renders its built-in MCP tools:
 * the call as `server/tool` with its arguments, and the result collapsed to a few wrapped lines with
 * the path of the full output when it was truncated.
 */

import { keyHint, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  getCapabilities,
  getImageDimensions,
  imageFallback,
  Spacer,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { McpToolDetails } from "./tools.ts";

/** Visual (wrapped) result lines shown before the output is expanded. */
const OUTPUT_PREVIEW_LINES = 5;
/** Characters of the arguments shown on a collapsed call line. */
const COLLAPSED_ARGS_CHARS = 100;

// Terminal escape sequences, as matched by ansi-regex (MIT, Sindre Sorhus). Valid string terminators
// are BEL, ESC\, and 0x9c; OSC sequences run to the first one.
const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const OSC_START = "\\u001B\\]";
const CSI_START = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?";
const CSI_FINAL = "[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI_PATTERN = new RegExp(`(?:${OSC_START}[\\s\\S]*?${ST})|${CSI_START}${CSI_FINAL}`, "g");

function stripAnsi(value: string): string {
  if (!value.includes("\u001B") && !value.includes("\u009B")) return value;
  return value.replace(ANSI_PATTERN, "");
}

/** Control characters that would garble the terminal. All are single UTF-16 code units. */
function sanitizeBinaryOutput(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

/** Text of a result, with an indicator for each image the terminal cannot show. */
function getTextOutput(
  result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
  showImages: boolean,
): string {
  if (!result) return "";
  const textBlocks = result.content.filter((block) => block.type === "text");
  const imageBlocks = result.content.filter((block) => block.type === "image");
  let output = textBlocks
    .map((block) => sanitizeBinaryOutput(stripAnsi(block.text || "")).replace(/\r/g, ""))
    .join("\n");
  if (imageBlocks.length > 0 && (!getCapabilities().images || !showImages)) {
    const indicators = imageBlocks
      .map((image) => {
        const mimeType = image.mimeType ?? "image/unknown";
        const dimensions =
          image.data && image.mimeType ? (getImageDimensions(image.data, image.mimeType) ?? undefined) : undefined;
        return imageFallback(mimeType, dimensions);
      })
      .join("\n");
    output = output ? `${output}\n${indicators}` : indicators;
  }
  return output;
}

/**
 * Tool call header: the title followed by the arguments. Collapsed, they are `key=value` pairs on the
 * title line, cut to {@link COLLAPSED_ARGS_CHARS}. Expanded, each is a `key: value` line below the
 * title, with strings shown raw and continuation lines indented.
 */
function formatToolCallWithArgs(title: string, args: unknown, theme: Theme, expanded: boolean): string {
  const header = theme.fg("toolTitle", theme.bold(title));
  if (args == null) return header;
  const entries =
    typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : ([["args", args]] as [string, unknown][]);
  if (entries.length === 0) return header;
  if (expanded) {
    const lines = entries.map(([key, value]) => {
      const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
      return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
    });
    return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
  }
  const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
  const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
  return `${header} ${theme.fg("muted", preview)}`;
}

/**
 * Collapsed output limited to its first visual lines, with a hint line for the rest. Limiting logical
 * lines instead lets a single long line (such as minified JSON) wrap across the whole screen. Caches
 * its lines per width, since it renders on every frame for every result in the transcript.
 */
class VisualLinePreview implements Component {
  private readonly text: string;
  private readonly maxVisualLines: number;
  private readonly formatHint: (hidden: number) => string;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(text: string, maxVisualLines: number, formatHint: (hidden: number) => string) {
    this.text = text;
    this.maxVisualLines = maxVisualLines;
    this.formatHint = formatHint;
  }

  render(width: number): string[] {
    if (this.cachedLines === undefined || this.cachedWidth !== width) {
      const lines = this.text ? new Text(this.text, 0, 0).render(width) : [];
      const hidden = lines.length - this.maxVisualLines;
      this.cachedLines =
        hidden > 0
          ? [...lines.slice(0, this.maxVisualLines), truncateToWidth(this.formatHint(hidden), width, "...")]
          : lines;
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/** Renderers of calls to an MCP tool, labeled `server/tool`, also used before the tool is registered. */
export function createMcpToolRenderers(label: string): ToolRenderers {
  return {
    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      component.setText(formatToolCallWithArgs(label, args, theme, context.expanded));
      return component;
    },
    renderResult(result, options, theme, context) {
      const component = (context.lastComponent as Container | undefined) ?? new Container();
      component.clear();
      const output = getTextOutput(result, context.showImages).trim();
      if (!output) return component;
      const color = context.isError ? "error" : "toolOutput";
      const styled = replaceTabs(output)
        .split("\n")
        .map((line) => theme.fg(color, line))
        .join("\n");
      component.addChild(new Spacer(1));
      if (options.expanded) {
        component.addChild(new Text(styled, 0, 0));
      } else {
        // Limit wrapped lines, not logical ones: MCP results are often one long JSON line.
        component.addChild(
          new VisualLinePreview(
            styled,
            OUTPUT_PREVIEW_LINES,
            (hidden) =>
              `${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
          ),
        );
        const fullOutputPath = (result.details as McpToolDetails | undefined)?.fullOutputPath;
        if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
      }
      return component;
    },
  };
}
