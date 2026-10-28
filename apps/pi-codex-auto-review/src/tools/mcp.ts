import type {
    ExtensionAPI,
    ExtensionFactory,
    InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { digest, type Json } from "../contracts.js";
import { mcpPackageApproval } from "../package-approvals.js";
import type { GuardController } from "./controller.js";
import type { ExternalToolCall, ExternalToolIdentity } from "./external.js";

type RegisteredToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
export interface ExternalExtension {
    readonly extension: InlineExtension;
    /** Trusted adapter metadata; model arguments and tool-result text never supply this. */
    readonly identifyTool: (
        definition: RegisteredToolDefinition,
    ) => ExternalToolIdentity;
}
export function guardedExternalExtension(
    input: ExternalExtension,
    controller: () => GuardController,
): InlineExtension {
    const factory =
        typeof input.extension === "function"
            ? input.extension
            : input.extension.factory;
    const guarded: ExtensionFactory = (api) =>
        factory(
            new Proxy(api, {
                get(target, key, receiver) {
                    if (key === "registerTool")
                        return (definition: RegisteredToolDefinition) =>
                            target.registerTool(
                                controller().wrapExternalTool(definition, () =>
                                    input.identifyTool(definition),
                                ),
                            );
                    return Reflect.get(target, key, receiver);
                },
            }),
        );
    return typeof input.extension === "function"
        ? guarded
        : { ...input.extension, factory: guarded };
}

export type McpToolPolicies = Readonly<
    Record<string, Partial<Pick<ExternalToolIdentity, "approvalMode">>>
>;
/** `pi.events` channel on which MCP extensions that keep `tools/list` `_meta` (pi-mcp-adapter) report it. */
const TOOL_META_CHANNEL = "tool-meta";
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
function optionalText(value: unknown): string | undefined {
    return typeof value === "string" && value.length ? value : undefined;
}

/**
 * Identifies a call to a tool that Pi's MCP extension, or a replacement such as pi-mcp-adapter,
 * registered: `mcp__<server>__<tool>` in the `mcp__<server>` namespace, whose first alias is the
 * server name. Pi replaces characters other than letters, digits and `_` in the tool part, so
 * `mcpToolPolicies` keys match after the same replacement. Pi's `getAllTools()` omits `_meta`;
 * without an extension answering the `tool-meta` channel, the Codex metadata flags stay unset.
 */
export function mcpToolCall(
    pi: Pick<ExtensionAPI, "getAllTools" | "events">,
    name: string,
    policies: McpToolPolicies = {},
): ExternalToolCall | undefined {
    const tool = pi.getAllTools().find((item) => item.name === name),
        namespace = tool?.namespace;
    if (
        !tool ||
        !namespace?.name.startsWith("mcp__") ||
        !name.startsWith(`${namespace.name}__`)
    )
        return undefined;
    const server =
        namespace.aliases?.[0] ?? namespace.name.slice("mcp__".length);
    const toolName = name.slice(namespace.name.length + 2);
    let meta: Record<string, unknown> = {};
    pi.events.emit(TOOL_META_CHANNEL, {
        reply: (tools: unknown) => {
            meta = { ...meta, ...record(record(tools)[name]) };
        },
    });
    const override = Object.entries(policies).find(([key]) => {
        const slash = key.indexOf("/");
        return (
            slash > 0 &&
            key.slice(0, slash) === server &&
            key.slice(slash + 1).replace(/[^A-Za-z0-9_]/g, "_") === toolName
        );
    })?.[1];
    const annotations = record(
        tool.annotations,
    ) as ExternalToolIdentity["annotations"];
    const schema = JSON.parse(
        JSON.stringify({
            parameters: tool.parameters,
            description: tool.description,
            annotations,
            namespace,
        }),
    ) as Json;
    const definition = JSON.parse(
        JSON.stringify({
            parameters: tool.parameters,
            description: tool.description,
            annotations,
            meta,
        }),
    ) as Json;
    const connectorId = optionalText(meta.connector_id);
    const account = optionalText(meta.account);
    const connectedAccountEmail = optionalText(meta.connected_account_email);
    return {
        identity: {
            kind: "mcp",
            server,
            tool: toolName,
            registration: digest({
                name,
                source: tool.sourceInfo.path,
                schema,
                meta,
            }),
            ...(connectorId ? { connectorId } : {}),
            ...(account ? { account } : {}),
            ...(connectedAccountEmail ? { connectedAccountEmail } : {}),
            ...(override?.approvalMode
                ? { approvalMode: override.approvalMode }
                : {}),
            annotations,
            requiresUserInput: meta.codex_requires_user_input === true,
            isSensitiveAction: meta.codex_sensitive_action === true,
            requiresStrictReview: meta.codex_strict_auto_review === true,
            packageApproval: mcpPackageApproval({
                server,
                tool: toolName,
                definition,
            }),
        },
        schema,
    };
}
