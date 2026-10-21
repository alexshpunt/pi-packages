import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    type Component,
    getCapabilities,
    getPngDimensions,
    hyperlink,
    Text,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
    defaultAppUnavailableReason,
    openWithDefaultApp,
} from "./open-image.js";

type ImageGenToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type RenderCall = NonNullable<ImageGenToolDefinition["renderCall"]>;
type RenderResult = NonNullable<ImageGenToolDefinition["renderResult"]>;
type Theme = Parameters<RenderCall>[1];

/** Base64 characters that decode to the 24-byte PNG signature and IHDR size fields. */
const PNG_SIZE_PREFIX_LENGTH = 32;
/** The summary starts with a blank line, then the heading, so the path is the third line. */
const PATH_LINE_INDEX = 2;

interface ResultRenderState {
    openStatus?: { text: string; isError: boolean };
}

function displayPath(path: string): string {
    const home = homedir();
    return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Arguments may still be streaming, so every field is checked before use. */
function describeRequest(args: unknown): string {
    const request = (args ?? {}) as Record<string, unknown>;
    const pathCount = Array.isArray(request.referenced_image_paths)
        ? request.referenced_image_paths.length
        : 0;
    const historyCount =
        typeof request.num_last_images_to_include === "number"
            ? request.num_last_images_to_include
            : 0;
    const operation =
        pathCount > 0
            ? `편집 · 참조 이미지 ${pathCount}개`
            : historyCount > 0
              ? `편집 · 최근 대화 이미지 ${historyCount}개`
              : "생성";
    return request.transparent_background === true
        ? `${operation} · 투명 배경`
        : operation;
}

/** Tool title and request summary, with the prompt on one line until the row is expanded. */
export const renderImageGenCall: RenderCall = (args, theme, context) => {
    const title = `${theme.fg("toolTitle", theme.bold("image_gen"))} ${theme.fg("accent", describeRequest(args))}`;
    const rawPrompt = (args as { prompt?: unknown } | undefined)?.prompt;
    const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
    return {
        render(width) {
            const lines = [truncateToWidth(title, width)];
            if (prompt === "") return lines;
            if (!context.expanded) {
                lines.push(
                    truncateToWidth(
                        theme.fg("muted", prompt.replace(/\s+/gu, " ")),
                        width,
                    ),
                );
                return lines;
            }
            for (const line of prompt.split("\n")) {
                lines.push(...wrapTextWithAnsi(theme.fg("muted", line), width));
            }
            return lines;
        },
        invalidate() {},
    };
};

function imageSize(content: readonly unknown[]): string | undefined {
    for (const block of content) {
        const candidate = block as { type?: unknown; data?: unknown };
        if (candidate.type !== "image" || typeof candidate.data !== "string")
            continue;
        const size = getPngDimensions(
            candidate.data.slice(0, PNG_SIZE_PREFIX_LENGTH),
        );
        return size ? `${size.widthPx}×${size.heightPx}` : undefined;
    }
    return undefined;
}

function resultHeading(details: unknown, content: readonly unknown[]): string {
    const { operation, background } = (details ?? {}) as {
        operation?: unknown;
        background?: unknown;
    };
    const parts = [operation === "edit" ? "편집 완료" : "생성 완료"];
    const size = imageSize(content);
    if (size !== undefined) parts.push(size);
    if (background === "transparent") parts.push("투명 배경");
    return parts.join(" · ");
}

function pathLabel(path: string, theme: Theme, width: number): string {
    const label = theme.fg("accent", truncateToWidth(displayPath(path), width));
    return getCapabilities().hyperlinks
        ? hyperlink(label, pathToFileURL(path).href)
        : label;
}

/**
 * Replaces the model-facing path hint with a short summary. Pi draws the image block below
 * this component on its own, and `image-zoom.ts` handles clicks on it. The path is an OSC 8 link
 * that Pi or the terminal opens; without link support, clicking the path line opens the file here.
 */
export const renderImageGenResult: RenderResult = (
    result,
    options,
    theme,
    context,
) => {
    const text = result.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
    if (context.isError) return new Text(theme.fg("error", text), 0, 0);
    if (options.isPartial)
        return new Text(
            `\n${theme.fg("muted", "이미지를 생성하는 중…")}`,
            0,
            0,
        );

    const state = context.state as ResultRenderState;
    const savedPath = (result.details as { savedPath?: unknown } | undefined)
        ?.savedPath;
    const path = typeof savedPath === "string" ? savedPath : undefined;
    const canOpen =
        path !== undefined && defaultAppUnavailableReason() === undefined;
    const heading = resultHeading(result.details, result.content);
    const isImageShown =
        getCapabilities().images !== null &&
        context.showImages &&
        result.content.some((block) => block.type === "image");
    const hint = [
        ...(isImageShown ? ["이미지 클릭: 확대·축소"] : []),
        ...(canOpen ? ["경로 클릭: 기본 앱으로 열기"] : []),
    ].join(" · ");

    const setOpenStatus = (text: string, isError: boolean) => {
        state.openStatus = { text, isError };
        context.invalidate();
    };

    return {
        render(width) {
            const lines = [
                "",
                truncateToWidth(theme.fg("success", heading), width),
                path === undefined
                    ? truncateToWidth(
                          theme.fg("warning", "파일로 저장하지 못했습니다."),
                          width,
                      )
                    : pathLabel(path, theme, width),
            ];
            if (hint !== "") {
                lines.push(truncateToWidth(theme.fg("dim", hint), width));
            }
            if (state.openStatus !== undefined) {
                const { text, isError } = state.openStatus;
                lines.push(
                    truncateToWidth(
                        theme.fg(isError ? "error" : "muted", text),
                        width,
                    ),
                );
            }
            return lines;
        },
        invalidate() {},
        handleMouse(event) {
            if (
                path === undefined ||
                !canOpen ||
                event.type !== "click" ||
                event.button !== "left" ||
                event.y !== PATH_LINE_INDEX ||
                event.x >= visibleWidth(displayPath(path))
            ) {
                return undefined;
            }
            setOpenStatus("기본 앱 실행을 요청하는 중…", false);
            openWithDefaultApp(path).then(
                () => setOpenStatus("기본 앱 실행을 요청했습니다.", false),
                (error: unknown) =>
                    setOpenStatus(
                        `열지 못했습니다: ${errorMessage(error)}`,
                        true,
                    ),
            );
            return { handled: true };
        },
    } satisfies Component;
};
