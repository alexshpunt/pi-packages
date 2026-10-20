import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
    type Component,
    getCellDimensions,
    Image,
    type TuiMouseEvent,
    type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** Rows kept for the editor and Pi's chrome when a zoomed image is sized to the screen. */
const ZOOM_RESERVED_ROWS = 8;
const MIN_ZOOM_ROWS = 4;
const FALLBACK_TERMINAL_ROWS = 24;
/** Global slots, so a `/reload` replaces the handler instead of wrapping the host method again. */
const ZOOM_HANDLER_SLOT = Symbol.for("@buyong/pi-codex-image-gen/image-zoom");
const WRAPPED_MARKER = Symbol.for(
    "@buyong/pi-codex-image-gen/image-zoom-wrapped",
);

/**
 * Host fields of a tool row that the zoom reads. Pi draws a tool result's images as children of
 * its `ToolExecutionComponent` without mouse handling, so these are not part of Pi's public types
 * and are checked before use.
 */
interface ToolRow {
    toolName?: unknown;
    imageWidthCells?: unknown;
    children?: unknown;
    setImageWidthCells?: unknown;
}

type ZoomHandler = (
    row: ToolRow,
    event: TuiMouseEvent,
) => TuiMouseEventResult | undefined;
type MouseHandler = (event: TuiMouseEvent) => unknown;

interface ZoomedWidth {
    normalWidthCells: number;
    zoomWidthCells: number;
}

const zoomedRows = new WeakMap<object, ZoomedWidth>();

/** The image drawn at the event's row, or `undefined` when another child is there. */
function imageAt(row: ToolRow, event: TuiMouseEvent): Image | undefined {
    if (!Array.isArray(row.children)) return undefined;
    let top = 0;
    for (const child of row.children as Component[]) {
        const height = child.render(event.width).length;
        if (event.y >= top && event.y < top + height) {
            return child instanceof Image ? child : undefined;
        }
        top += height;
    }
    return undefined;
}

/** The widest image that still fits the terminal height, capped by the row width. */
function zoomWidthCells(image: Image, rowWidth: number): number {
    const dimensions = (
        image as unknown as {
            dimensions?: { widthPx: number; heightPx: number };
        }
    ).dimensions;
    const widthPx = dimensions?.widthPx || 1;
    const heightPx = dimensions?.heightPx || 1;
    const cell = getCellDimensions();
    const rows = Math.max(
        MIN_ZOOM_ROWS,
        (process.stdout.rows || FALLBACK_TERMINAL_ROWS) - ZOOM_RESERVED_ROWS,
    );
    const columnsForRows = Math.floor(
        (rows * cell.heightPx * widthPx) / (cell.widthPx * heightPx),
    );
    return Math.max(1, Math.min(rowWidth, columnsForRows));
}

/** Toggles the clicked `image_gen` row between Pi's image width and the zoomed width. */
function createZoomHandler(toolName: string): ZoomHandler {
    return (row, event) => {
        if (
            row.toolName !== toolName ||
            event.type !== "click" ||
            event.button !== "left" ||
            typeof row.imageWidthCells !== "number" ||
            typeof row.setImageWidthCells !== "function"
        ) {
            return undefined;
        }
        const image = imageAt(row, event);
        if (image === undefined) return undefined;
        const setImageWidthCells = row.setImageWidthCells as (
            width: number,
        ) => void;
        const zoomed = zoomedRows.get(row);
        // Pi resets every row's width when its image-width setting changes; that row is no longer zoomed.
        if (
            zoomed !== undefined &&
            row.imageWidthCells === zoomed.zoomWidthCells
        ) {
            zoomedRows.delete(row);
            setImageWidthCells.call(row, zoomed.normalWidthCells);
            return { handled: true };
        }
        const zoomWidth = zoomWidthCells(image, event.width);
        if (zoomWidth <= row.imageWidthCells) return { handled: true };
        zoomedRows.set(row, {
            normalWidthCells: row.imageWidthCells,
            zoomWidthCells: zoomWidth,
        });
        setImageWidthCells.call(row, zoomWidth);
        return { handled: true };
    };
}

/**
 * Lets a click on a generated image zoom that row's image. Pi offers no hook for clicks on the
 * images it draws, so the host's tool-row mouse handler is wrapped once; clicks it already handles
 * are left alone.
 */
export function enableImageZoom(toolName: string): void {
    const slots = globalThis as Record<symbol, unknown>;
    slots[ZOOM_HANDLER_SLOT] = createZoomHandler(toolName);
    const prototype = ToolExecutionComponent.prototype as unknown as Record<
        symbol,
        unknown
    > & { handleMouse: MouseHandler };
    if (prototype[WRAPPED_MARKER] === true) return;
    const hostHandleMouse = prototype.handleMouse;
    prototype.handleMouse = function (this: ToolRow, event: TuiMouseEvent) {
        const result = hostHandleMouse.call(this, event);
        if (result !== undefined) return result;
        const handler = slots[ZOOM_HANDLER_SLOT];
        return typeof handler === "function"
            ? (handler as ZoomHandler)(this, event)
            : undefined;
    };
    prototype[WRAPPED_MARKER] = true;
}

/** Stops zooming on clicks; the wrapper stays installed and passes every event through. */
export function disableImageZoom(): void {
    delete (globalThis as Record<symbol, unknown>)[ZOOM_HANDLER_SLOT];
}
