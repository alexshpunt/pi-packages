import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActiveCall, ActiveCallTracker } from "./active-call.js";
import type {
    ElicitationHandler,
    ElicitationParams,
    ElicitationResult,
} from "./connection.js";
import type { BridgeLog } from "./log.js";

/*
 * Replicates Codex's handling of MCP `elicitation/create` requests from the Computer Use runtime:
 * the TUI option set (tui/src/bottom_pane/mcp_server_elicitation.rs), the response shapes, and the
 * user-reviewer auto-approval of `js` execution requests (core/src/session/mcp.rs). Approval is by
 * the user only; no automatic reviewer is involved.
 */

export type ElicitationKind =
    | "auto-approve"
    | "tool-approval"
    | "message-only"
    | "form"
    | "url"
    | "browser-auth"
    | "otp"
    | "unsupported";

export type PersistMode = "session" | "always";

export interface DisplayParam {
    name: string;
    displayName: string;
    value: string;
}

export interface FormField {
    id: string;
    label: string;
    prompt: string;
    required: boolean;
    input:
        | {
              kind: "text";
              minLength?: number;
              maxLength?: number;
              format?: string;
          }
        | {
              kind: "number";
              integer: boolean;
              minimum?: number;
              maximum?: number;
          }
        | { kind: "boolean"; defaultValue?: boolean }
        | {
              kind: "enum";
              options: { label: string; value: unknown }[];
              defaultIndex?: number;
          };
}

export interface Classification {
    kind: ElicitationKind;
    message: string;
    connectorId?: string;
    connectorName?: string;
    toolName?: string;
    toolTitle?: string;
    riskLevel?: string;
    approvalKind?: string;
    requestType?: string;
    isStrictAutoReview: boolean;
    isSensitiveAction: boolean;
    requiresUserInput: boolean;
    persistModes: PersistMode[];
    displayParams: DisplayParam[];
    fields: FormField[];
    /** Why kinds that pi cannot answer are declined. */
    declineReason?: string;
}

export type ApprovalChoice =
    | "accept"
    | "accept_session"
    | "accept_always"
    | "decline"
    | "cancel";

export interface DialogOption {
    label: string;
    description: string;
    value: ApprovalChoice;
}

const META_KEYS = {
    approvalKind: "codex_approval_kind",
    requiresUserInput: "codex_requires_user_input",
    requestType: "codex_request_type",
    strictAutoReview: "codex_strict_auto_review",
    sensitiveAction: "codex_sensitive_action",
    persist: "persist",
    connectorId: "connector_id",
    connectorName: "connector_name",
    toolName: "tool_name",
    toolTitle: "tool_title",
    toolParamsDisplay: "tool_params_display",
    riskLevel: "riskLevel",
} as const;

export const AUTO_APPROVE_RESPONSE: Readonly<ElicitationResult> = Object.freeze(
    {
        action: "accept",
        content: {},
        _meta: { approvals_reviewer: "auto_review" },
    },
);

export const DECLINE_REASONS = {
    url: "pi cannot open URL-based approval requests, so this request was declined.",
    browserAuth:
        "pi has no browser sign-in surface (QR code or screenshot), so this request was declined.",
    otp: "pi has no one-time-code input surface, so this request was declined.",
    unsupported:
        "pi cannot render this request's form, so this request was declined.",
    noUi: "This pi session has no interactive approval surface (print or JSON mode); run pi interactively to approve Computer Use requests.",
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function metaString(
    meta: Record<string, unknown>,
    key: string,
): string | undefined {
    const value = meta[key];
    return typeof value === "string" && value.trim() ? value : undefined;
}

function persistModes(meta: Record<string, unknown>): PersistMode[] {
    const persist = meta[META_KEYS.persist];
    const values = Array.isArray(persist)
        ? persist
        : typeof persist === "string"
          ? [persist]
          : [];
    const modes: PersistMode[] = [];
    if (values.includes("session")) modes.push("session");
    if (values.includes("always")) modes.push("always");
    return modes;
}

function displayParams(meta: Record<string, unknown>): DisplayParam[] {
    const raw = meta[META_KEYS.toolParamsDisplay];
    if (!Array.isArray(raw)) return [];
    const params: DisplayParam[] = [];
    for (const entry of raw) {
        const record = asRecord(entry);
        if (!record) continue;
        const name = typeof record.name === "string" ? record.name : "";
        const displayName =
            typeof record.display_name === "string" &&
            record.display_name.trim()
                ? record.display_name
                : name;
        if (!displayName) continue;
        const value = record.value;
        params.push({
            name,
            displayName,
            value:
                typeof value === "string"
                    ? value
                    : JSON.stringify(value ?? null),
        });
    }
    return params;
}

/** Codex: `requested_schema` null, or an object schema whose `properties` is empty. */
export function isMessageOnlySchema(schema: unknown): boolean {
    if (schema === undefined || schema === null) return true;
    const record = asRecord(schema);
    if (!record) return false;
    if (record.type !== undefined && record.type !== "object") return false;
    const properties = asRecord(record.properties);
    return properties === undefined || Object.keys(properties).length === 0;
}

function parseField(
    id: string,
    schema: Record<string, unknown>,
    required: boolean,
): FormField | undefined {
    const label =
        typeof schema.title === "string" && schema.title ? schema.title : id;
    const prompt =
        typeof schema.description === "string" && schema.description
            ? schema.description
            : label;
    const base = { id, label, prompt, required };
    if (Array.isArray(schema.enum)) {
        const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
        const options = schema.enum.map((value, index) => ({
            label:
                typeof names[index] === "string"
                    ? (names[index] as string)
                    : String(value),
            value,
        }));
        const defaultIndex = schema.enum.indexOf(schema.default);
        return {
            ...base,
            input: {
                kind: "enum",
                options,
                defaultIndex: defaultIndex >= 0 ? defaultIndex : undefined,
            },
        };
    }
    if (Array.isArray(schema.oneOf)) {
        const options: { label: string; value: unknown }[] = [];
        for (const entry of schema.oneOf) {
            const record = asRecord(entry);
            if (!record || !("const" in record)) return undefined;
            options.push({
                label:
                    typeof record.title === "string"
                        ? record.title
                        : String(record.const),
                value: record.const,
            });
        }
        if (options.length === 0) return undefined;
        return { ...base, input: { kind: "enum", options } };
    }
    switch (schema.type) {
        case "string":
            return {
                ...base,
                input: {
                    kind: "text",
                    minLength:
                        typeof schema.minLength === "number"
                            ? schema.minLength
                            : undefined,
                    maxLength:
                        typeof schema.maxLength === "number"
                            ? schema.maxLength
                            : undefined,
                    format:
                        typeof schema.format === "string"
                            ? schema.format
                            : undefined,
                },
            };
        case "number":
        case "integer":
            return {
                ...base,
                input: {
                    kind: "number",
                    integer: schema.type === "integer",
                    minimum:
                        typeof schema.minimum === "number"
                            ? schema.minimum
                            : undefined,
                    maximum:
                        typeof schema.maximum === "number"
                            ? schema.maximum
                            : undefined,
                },
            };
        case "boolean":
            return {
                ...base,
                input: {
                    kind: "boolean",
                    defaultValue:
                        typeof schema.default === "boolean"
                            ? schema.default
                            : undefined,
                },
            };
        default:
            return undefined;
    }
}

/** Fields of an object schema in declaration order; `undefined` when a property cannot be rendered. */
export function parseFormFields(schema: unknown): FormField[] | undefined {
    const record = asRecord(schema);
    if (!record || (record.type !== undefined && record.type !== "object"))
        return undefined;
    const properties = asRecord(record.properties);
    if (!properties) return undefined;
    const required = new Set(
        Array.isArray(record.required)
            ? record.required.filter(
                  (entry): entry is string => typeof entry === "string",
              )
            : [],
    );
    const fields: FormField[] = [];
    for (const [id, property] of Object.entries(properties)) {
        const propertySchema = asRecord(property);
        if (!propertySchema) return undefined;
        const field = parseField(id, propertySchema, required.has(id));
        if (!field) return undefined;
        fields.push(field);
    }
    return fields.length > 0 ? fields : undefined;
}

/** Classifies a request exactly as Codex decides what to show or auto-answer. */
export function classify(params: ElicitationParams): Classification {
    const meta = asRecord(params._meta) ?? {};
    const approvalKind = metaString(meta, META_KEYS.approvalKind);
    const connectorId = metaString(meta, META_KEYS.connectorId);
    const toolName = metaString(meta, META_KEYS.toolName);
    const messageOnly = isMessageOnlySchema(params.requestedSchema);
    const base: Omit<Classification, "kind"> = {
        message: typeof params.message === "string" ? params.message : "",
        connectorId,
        connectorName: metaString(meta, META_KEYS.connectorName),
        toolName,
        toolTitle: metaString(meta, META_KEYS.toolTitle),
        riskLevel: metaString(meta, META_KEYS.riskLevel),
        approvalKind,
        requestType: metaString(meta, META_KEYS.requestType),
        isStrictAutoReview: meta[META_KEYS.strictAutoReview] === true,
        isSensitiveAction: meta[META_KEYS.sensitiveAction] === true,
        requiresUserInput: meta[META_KEYS.requiresUserInput] === true,
        persistModes: persistModes(meta),
        displayParams:
            approvalKind === "mcp_tool_call" && messageOnly
                ? displayParams(meta)
                : [],
        fields: [],
    };
    if (params.mode === "url")
        return { ...base, kind: "url", declineReason: DECLINE_REASONS.url };
    if (approvalKind === "browser_auth")
        return {
            ...base,
            kind: "browser-auth",
            declineReason: DECLINE_REASONS.browserAuth,
        };
    if (approvalKind === "browser_email_otp")
        return { ...base, kind: "otp", declineReason: DECLINE_REASONS.otp };
    // Auto-approval requires a real empty object form, not an absent or malformed schema.
    const schema = asRecord(params.requestedSchema);
    const properties = asRecord(schema?.properties);
    const hasEmptyForm =
        schema?.type === "object" &&
        properties !== undefined &&
        Object.keys(properties).length === 0;
    // Codex core, user reviewer: a js execution approval from node_repl with an empty form is accepted silently.
    if (
        hasEmptyForm &&
        toolName === "js" &&
        connectorId === "node_repl" &&
        approvalKind === "mcp_tool_call" &&
        !base.isSensitiveAction &&
        !base.requiresUserInput
    )
        return { ...base, kind: "auto-approve" };
    if (messageOnly)
        return {
            ...base,
            kind:
                approvalKind === "mcp_tool_call"
                    ? "tool-approval"
                    : "message-only",
        };
    const fields = parseFormFields(params.requestedSchema);
    if (!fields)
        return {
            ...base,
            kind: "unsupported",
            declineReason: DECLINE_REASONS.unsupported,
        };
    return { ...base, kind: "form", fields };
}

/** Codex TUI option set: Allow, Allow for this session, Always allow, then Cancel (tool approvals) or Deny + Cancel. */
export function buildOptions(classification: Classification): DialogOption[] {
    const isTool = classification.kind === "tool-approval";
    const options: DialogOption[] = [
        {
            label: "Allow",
            description: isTool
                ? "Run the tool and continue"
                : "Allow this request and continue",
            value: "accept",
        },
    ];
    if (classification.persistModes.includes("session"))
        options.push({
            label: "Allow for this session",
            description: isTool
                ? "Run the tool and remember this choice for this session"
                : "Allow this request and remember this choice for this session",
            value: "accept_session",
        });
    if (classification.persistModes.includes("always"))
        options.push({
            label: "Always allow",
            description: isTool
                ? "Run the tool and remember this choice for future tool calls"
                : "Allow this request and remember this choice for future requests",
            value: "accept_always",
        });
    if (isTool)
        options.push({
            label: "Cancel",
            description: "Cancel this tool call",
            value: "cancel",
        });
    else
        options.push(
            {
                label: "Deny",
                description: "Decline this request and continue",
                value: "decline",
            },
            {
                label: "Cancel",
                description: "Cancel this request",
                value: "cancel",
            },
        );
    return options;
}

/** Codex TUI `submit_answers` mapping; a dismissed dialog is `cancel`. */
export function responseForChoice(
    choice: ApprovalChoice | undefined,
): ElicitationResult {
    switch (choice) {
        case "accept":
            return { action: "accept" };
        case "accept_session":
            return { action: "accept", _meta: { persist: "session" } };
        case "accept_always":
            return { action: "accept", _meta: { persist: "always" } };
        case "decline":
            return { action: "decline" };
        default:
            return { action: "cancel" };
    }
}

export function declineWithMessage(message: string): ElicitationResult {
    return { action: "decline", _meta: { message } };
}

/** Dialog title: the request message, who asks, risk, and the display rows Codex shows. */
export function formatDialogTitle(classification: Classification): string {
    const lines = [classification.message || "Approval requested"];
    const who = [
        classification.connectorName ?? classification.connectorId,
        classification.toolTitle ??
            (classification.toolName && classification.toolName !== "js"
                ? classification.toolName
                : undefined),
    ]
        .filter(Boolean)
        .join(" · ");
    if (who) lines.push(who);
    if (classification.riskLevel && classification.riskLevel !== "low")
        lines.push(`Risk: ${classification.riskLevel}`);
    for (const param of classification.displayParams)
        lines.push(`${param.displayName}: ${param.value}`);
    return lines.join("\n");
}

function optionLabel(option: DialogOption): string {
    return `${option.label} — ${option.description}`;
}

function combineSignals(
    signals: (AbortSignal | undefined)[],
): AbortSignal | undefined {
    const present = signals.filter(
        (signal): signal is AbortSignal => signal !== undefined,
    );
    if (present.length === 0) return undefined;
    return present.length === 1 ? present[0] : AbortSignal.any(present);
}

async function askField(
    ctx: ExtensionContext,
    field: FormField,
    signal: AbortSignal | undefined,
): Promise<{ value: unknown } | undefined> {
    const title = field.required ? `${field.label} (required)` : field.label;
    const options = { signal };
    switch (field.input.kind) {
        case "boolean": {
            const choice = await ctx.ui.select(
                `${title}\n${field.prompt}`,
                ["True", "False"],
                options,
            );
            if (choice === undefined) return undefined;
            return { value: choice === "True" };
        }
        case "enum": {
            const labels = field.input.options.map((option) => option.label);
            const choice = await ctx.ui.select(
                `${title}\n${field.prompt}`,
                labels,
                options,
            );
            if (choice === undefined) return undefined;
            const index = labels.indexOf(choice);
            return index >= 0
                ? { value: field.input.options[index].value }
                : undefined;
        }
        case "text":
        case "number": {
            let error = "";
            for (;;) {
                const raw = await ctx.ui.input(
                    `${title}\n${field.prompt}${error ? `\n${error}` : ""}`,
                    undefined,
                    options,
                );
                if (raw === undefined) return undefined;
                if (field.input.kind === "text") {
                    if (
                        field.input.minLength !== undefined &&
                        raw.length < field.input.minLength
                    ) {
                        error = `Enter at least ${field.input.minLength} characters.`;
                        continue;
                    }
                    if (
                        field.input.maxLength !== undefined &&
                        raw.length > field.input.maxLength
                    ) {
                        error = `Enter at most ${field.input.maxLength} characters.`;
                        continue;
                    }
                    if (!raw && field.required) {
                        error = "A value is required.";
                        continue;
                    }
                    return { value: raw };
                }
                const parsed = Number(raw.trim());
                if (!raw.trim() || !Number.isFinite(parsed)) {
                    error = "Enter a finite number.";
                    continue;
                }
                if (field.input.integer && !Number.isInteger(parsed)) {
                    error = "Enter a whole number.";
                    continue;
                }
                if (
                    field.input.minimum !== undefined &&
                    parsed < field.input.minimum
                ) {
                    error = `Enter a number of at least ${field.input.minimum}.`;
                    continue;
                }
                if (
                    field.input.maximum !== undefined &&
                    parsed > field.input.maximum
                ) {
                    error = `Enter a number of at most ${field.input.maximum}.`;
                    continue;
                }
                return { value: parsed };
            }
        }
        default:
            return undefined;
    }
}

export interface ElicitationHost {
    /** The bridged call whose runtime code asked for confirmation. */
    activeCalls: ActiveCallTracker;
    /** Used when no bridged call is active (should not happen); the last session context. */
    getFallbackContext(): ExtensionContext | undefined;
    log: BridgeLog;
}

function noteForActiveCall(active: ActiveCall | undefined, note: string): void {
    if (active && !active.notes.includes(note)) active.notes.push(note);
}

/**
 * The `elicitation/create` handler installed on the bridge connection. Auto-approves what Codex's
 * user reviewer auto-approves, declines what pi cannot render, and otherwise asks the user with
 * Codex's option set; without UI it declines with `_meta.message`.
 */
export function createElicitationHandler(
    host: ElicitationHost,
): ElicitationHandler {
    return async (params, context) => {
        const classification = classify(params);
        const active = host.activeCalls.current;
        host.log.write("elicitation-request", {
            kind: classification.kind,
            message: classification.message,
            callId: active?.callId,
            meta: params._meta,
            requestedSchema: params.requestedSchema,
        });
        const signal = combineSignals([active?.signal, context.signal]);
        if (signal?.aborted) {
            host.log.write("elicitation-cancelled", {
                kind: classification.kind,
                reason: "aborted",
            });
            return classification.kind === "auto-approve"
                ? {
                      action: "cancel",
                      _meta: { approvals_reviewer: "auto_review" },
                  }
                : { action: "cancel" };
        }
        if (classification.kind === "auto-approve") {
            host.log.write("elicitation-auto-approved", { meta: params._meta });
            return { ...AUTO_APPROVE_RESPONSE, content: {} };
        }
        if (classification.declineReason) {
            noteForActiveCall(active, classification.declineReason);
            host.log.write("elicitation-declined", {
                kind: classification.kind,
                reason: classification.declineReason,
            });
            return declineWithMessage(classification.declineReason);
        }
        const ctx = active?.ctx ?? host.getFallbackContext();
        if (!ctx?.hasUI) {
            noteForActiveCall(active, DECLINE_REASONS.noUi);
            host.log.write("elicitation-declined", {
                kind: classification.kind,
                reason: "no-ui",
            });
            return declineWithMessage(DECLINE_REASONS.noUi);
        }
        const startedAt = Date.now();
        if (classification.kind === "form") {
            const content: Record<string, unknown> = {};
            for (const field of classification.fields) {
                const answer = await askField(ctx, field, signal);
                if (answer === undefined) {
                    host.log.write("elicitation-cancelled", {
                        kind: "form",
                        field: field.id,
                        waitedMs: Date.now() - startedAt,
                    });
                    return { action: "cancel" };
                }
                content[field.id] = answer.value;
            }
            host.log.write("elicitation-answered", {
                kind: "form",
                fields: Object.keys(content),
                waitedMs: Date.now() - startedAt,
            });
            return { action: "accept", content };
        }
        const options = buildOptions(classification);
        const labels = options.map(optionLabel);
        const chosen = await ctx.ui.select(
            formatDialogTitle(classification),
            labels,
            { signal },
        );
        const choice = options[labels.indexOf(chosen ?? "")]?.value;
        const response = responseForChoice(choice);
        host.log.write(
            response.action === "cancel"
                ? "elicitation-cancelled"
                : "elicitation-answered",
            {
                kind: classification.kind,
                choice: choice ?? "dismissed",
                response,
                waitedMs: Date.now() - startedAt,
            },
        );
        return response;
    };
}
