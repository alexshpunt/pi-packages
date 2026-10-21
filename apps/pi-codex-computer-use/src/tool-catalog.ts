import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "@earendil-works/pi-mcp";
import type { ComposedEnvironment } from "./connection.js";
import type { RuntimePlan } from "./runtime.js";
import type { FeatureState } from "./settings.js";

const CATALOG_VERSION = 1;

/** What tool registration needs: a live connection, or a cached catalog before the server starts. */
export interface ToolCatalog {
    readonly plan: RuntimePlan;
    readonly state: FeatureState;
    readonly environment: ComposedEnvironment;
    readonly instructions: string | undefined;
    /** Every tool the server lists, including the ones never exposed to the model. */
    readonly tools: Tool[];
}

export type ServerCatalog = Pick<ToolCatalog, "instructions" | "tools">;

/** Identifies one runtime plan and feature state; a cached catalog is reused only for the same key. */
export function catalogKey(plan: RuntimePlan, state: FeatureState): string {
    return createHash("sha256")
        .update(JSON.stringify({ version: CATALOG_VERSION, plan, state }))
        .digest("hex");
}

export function isSameCatalog(a: ServerCatalog, b: ServerCatalog): boolean {
    return (
        a.instructions === b.instructions &&
        JSON.stringify(a.tools) === JSON.stringify(b.tools)
    );
}

function isToolList(value: unknown): value is Tool[] {
    return (
        Array.isArray(value) &&
        value.every(
            (tool) =>
                typeof tool?.name === "string" &&
                typeof tool.inputSchema === "object" &&
                tool.inputSchema !== null,
        )
    );
}

/**
 * The server's last `initialize` instructions and `tools/list` result, stored so a later session can
 * register the same tools and start the server only when a tool is first called. Read and write
 * failures only cost a server start at `session_start`.
 */
export class ToolCatalogStore {
    constructor(readonly path: string) {}

    async load(key: string): Promise<ServerCatalog | undefined> {
        try {
            const data = JSON.parse(await readFile(this.path, "utf8"));
            if (
                data?.version !== CATALOG_VERSION ||
                data.key !== key ||
                !isToolList(data.tools) ||
                (data.instructions !== undefined &&
                    typeof data.instructions !== "string")
            )
                return undefined;
            return { instructions: data.instructions, tools: data.tools };
        } catch {
            return undefined;
        }
    }

    async save(key: string, catalog: ServerCatalog): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            await writeFile(
                temporary,
                `${JSON.stringify({
                    version: CATALOG_VERSION,
                    key,
                    instructions: catalog.instructions,
                    tools: catalog.tools,
                })}\n`,
                { mode: 0o600, flag: "wx" },
            );
            await rename(temporary, this.path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}
