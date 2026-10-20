import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    formatIssue,
    type NormalizedRedactionConfig,
    normalizeRedactionConfig,
    type RedactionConfig,
} from "@buyong/redact";
import {
    type ApprovalPolicy,
    createProfile,
    decision,
    digest,
    EMPTY_DELTA,
    type GuardAction,
    GuardError,
    immutable,
    type PermissionProfile,
    type PolicyDecision,
    TOOL_NAMES,
} from "../contracts.js";
import { reviewPolicy } from "../review/policy.js";
import {
    isDomainPattern,
    isNetworkHost,
    matchesDomain,
    normalizeHost,
} from "./domains.js";
import { canonicalPath, isWithin, resolveToolPath } from "./paths.js";
import {
    type CompiledRules,
    evaluateRules,
    matchesRule,
    type PrefixRule,
    type RuleMatch,
    type RuleSource,
    ruleCommands,
} from "./rules.js";
import { analyzeShell, matchesPrefix } from "./shell.js";

export {
    analyzeShell,
    canonicalPath,
    isWithin,
    matchesPrefix,
    resolveToolPath,
};

export interface CommandRule {
    readonly prefix: readonly string[];
    readonly decision: "allow" | "ask" | "deny";
}
export interface GuardSettings {
    readonly isEnabled: boolean;
    readonly mode: "read-only" | "workspace-write";
    readonly commandRules: readonly CommandRule[];
    readonly allowedDomains: readonly string[];
    readonly reviewTimeoutMs: number;
    readonly approvalTimeoutMs: number;
    readonly executionTimeoutSeconds: number;
    readonly trustedTools: readonly string[];
    readonly approvalPolicy: ApprovalPolicy;
    readonly approvalsReviewer: "auto_review" | "user";
    readonly reviewModel: {
        readonly provider: string;
        readonly id: string;
    } | null;
    /** Replaces only the tenant policy; intrinsic risk, trust and outcome rules remain enforced. */
    readonly reviewPolicy: string | null;
    readonly reviewMaxRounds: number;
    readonly reviewMaxOutputTokens: number;
    readonly reviewContextChars: number;
    readonly reviewCacheTtlHours: number;
    readonly ruleFiles: readonly string[];
    readonly writableRoots: readonly string[];
    readonly excludeSlashTmp: boolean;
    readonly excludeTmpdir: boolean;
    readonly projectDocMaxBytes: number;
    readonly projectDocFallbackFilenames: readonly string[];
    readonly projectRootMarkers: readonly string[] | null;
    /** Additions to reviewer-bound masking; reviewer redaction itself cannot be disabled. */
    readonly redaction: NormalizedRedactionConfig;
}
/** Settings as callers supply them; validation fills omitted keys, including omitted redaction lists. */
export type GuardSettingsInput = Partial<Omit<GuardSettings, "redaction">> & {
    readonly redaction?: RedactionConfig;
};
export const DEFAULT_SETTINGS: GuardSettings = immutable({
    isEnabled: true,
    mode: "workspace-write",
    commandRules: [],
    allowedDomains: [],
    reviewTimeoutMs: 20_000,
    approvalTimeoutMs: 60_000,
    executionTimeoutSeconds: 120,
    trustedTools: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    reviewModel: null,
    reviewPolicy: null,
    reviewMaxRounds: 4,
    reviewMaxOutputTokens: 2048,
    reviewContextChars: 60000,
    reviewCacheTtlHours: 3,
    ruleFiles: [],
    writableRoots: [],
    excludeSlashTmp: false,
    excludeTmpdir: false,
    projectDocMaxBytes: 32768,
    projectDocFallbackFilenames: [],
    projectRootMarkers: null,
    redaction: {
        sensitiveFields: [],
        rules: [],
        exceptions: [],
        piiEntities: [],
    },
});
export function validateSettings(value: unknown): GuardSettings {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new GuardError("INVALID_SETTINGS", "Settings must be an object");
    const raw = value as Record<string, unknown>;
    for (const key of Object.keys(raw))
        if (!Object.hasOwn(DEFAULT_SETTINGS, key))
            throw new GuardError("INVALID_SETTINGS", `Unknown setting: ${key}`);
    const settings = { ...DEFAULT_SETTINGS, ...raw } as GuardSettings;
    if (typeof settings.isEnabled !== "boolean")
        throw new GuardError("INVALID_SETTINGS", "Invalid isEnabled");
    if (!["read-only", "workspace-write"].includes(settings.mode))
        throw new GuardError("INVALID_SETTINGS", "Unknown mode");
    for (const key of [
        "reviewTimeoutMs",
        "approvalTimeoutMs",
        "executionTimeoutSeconds",
    ] as const)
        if (!Number.isFinite(settings[key]) || settings[key] <= 0)
            throw new GuardError("INVALID_SETTINGS", `Invalid ${key}`);
    if (
        !Array.isArray(settings.allowedDomains) ||
        settings.allowedDomains.some((x) => !isDomainPattern(x))
    )
        throw new GuardError("INVALID_SETTINGS", "Invalid domains");
    if (
        !Array.isArray(settings.trustedTools) ||
        settings.trustedTools.some((x) => typeof x !== "string" || !x)
    )
        throw new GuardError("INVALID_SETTINGS", "Invalid trusted tools");
    const approval = settings.approvalPolicy;
    if (
        approval !== "on-request" &&
        approval !== "never" &&
        (!approval ||
            typeof approval !== "object" ||
            Array.isArray(approval) ||
            Object.keys(approval).some(
                (key) =>
                    !["sandbox", "rules", "mcp_elicitations"].includes(key),
            ) ||
            typeof approval.sandbox !== "boolean" ||
            typeof approval.rules !== "boolean" ||
            (approval.mcp_elicitations !== undefined &&
                typeof approval.mcp_elicitations !== "boolean"))
    )
        throw new GuardError("INVALID_SETTINGS", "Invalid approval policy");
    if (!["auto_review", "user"].includes(settings.approvalsReviewer))
        throw new GuardError("INVALID_SETTINGS", "Invalid approvals reviewer");
    if (
        settings.reviewModel !== null &&
        (!settings.reviewModel ||
            typeof settings.reviewModel !== "object" ||
            Array.isArray(settings.reviewModel) ||
            Object.keys(settings.reviewModel).some(
                (key) => !["provider", "id"].includes(key),
            ) ||
            ![settings.reviewModel.provider, settings.reviewModel.id].every(
                (value) =>
                    typeof value === "string" &&
                    value.trim().length > 0 &&
                    !/[\0\r\n]/.test(value),
            ))
    )
        throw new GuardError("INVALID_SETTINGS", "Invalid review model");
    if (
        settings.reviewPolicy !== null &&
        (typeof settings.reviewPolicy !== "string" ||
            !settings.reviewPolicy.trim() ||
            settings.reviewPolicy.length > 100000)
    )
        throw new GuardError("INVALID_SETTINGS", "Invalid reviewer policy");
    for (const [key, maximum] of [
        ["reviewMaxRounds", 16],
        ["reviewMaxOutputTokens", 16384],
        ["reviewContextChars", 500000],
        ["reviewCacheTtlHours", 12],
    ] as const)
        if (
            !Number.isInteger(settings[key]) ||
            settings[key] < 1 ||
            settings[key] > maximum
        )
            throw new GuardError("INVALID_SETTINGS", `Invalid ${key}`);
    for (const key of ["ruleFiles", "writableRoots"] as const)
        if (
            !Array.isArray(settings[key]) ||
            settings[key].some(
                (value) =>
                    typeof value !== "string" || !value || value.includes("\0"),
            )
        )
            throw new GuardError("INVALID_SETTINGS", `Invalid ${key}`);
    for (const key of ["excludeSlashTmp", "excludeTmpdir"] as const)
        if (typeof settings[key] !== "boolean")
            throw new GuardError("INVALID_SETTINGS", `Invalid ${key}`);
    if (
        !Number.isSafeInteger(settings.projectDocMaxBytes) ||
        settings.projectDocMaxBytes < 0 ||
        settings.projectDocMaxBytes > 1000000
    )
        throw new GuardError(
            "INVALID_SETTINGS",
            "Invalid project document byte budget",
        );
    for (const values of [
        settings.projectDocFallbackFilenames,
        settings.projectRootMarkers ?? [],
    ])
        if (
            !Array.isArray(values) ||
            values.some((value) => typeof value !== "string")
        )
            throw new GuardError(
                "INVALID_SETTINGS",
                "Invalid context discovery filenames",
            );
    if (!Array.isArray(settings.commandRules))
        throw new GuardError("INVALID_SETTINGS", "Invalid command rules");
    for (const rule of settings.commandRules) {
        if (
            !rule ||
            !["allow", "ask", "deny"].includes(rule.decision) ||
            !Array.isArray(rule.prefix) ||
            !rule.prefix.length ||
            rule.prefix.some(
                (x: unknown) => typeof x !== "string" || !x || /[\0\n]/.test(x),
            )
        )
            throw new GuardError("INVALID_SETTINGS", "Invalid command rule");
        if (Object.keys(rule).some((k) => !["prefix", "decision"].includes(k)))
            throw new GuardError(
                "INVALID_SETTINGS",
                "Unknown command rule field",
            );
    }
    const redaction =
        settings.redaction &&
        typeof settings.redaction === "object" &&
        !Array.isArray(settings.redaction)
            ? normalizeRedactionConfig(settings.redaction)
            : undefined;
    // Issues name only the key and index, never a pattern, value or parser message.
    if (!redaction || redaction.issues.length)
        throw new GuardError(
            "INVALID_SETTINGS",
            redaction
                ? `Invalid redaction: ${redaction.issues.map(formatIssue).join("; ")}`
                : "Invalid redaction",
        );
    return immutable(
        JSON.parse(
            JSON.stringify({ ...settings, redaction: redaction.config }),
        ),
    );
}
export async function loadSettings(path: string): Promise<GuardSettings> {
    try {
        return validateSettings(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
        throw new GuardError(
            "INVALID_SETTINGS",
            "Permission settings could not be loaded",
            { cause: error },
        );
    }
}
export async function defaultProfile(
    cwd: string,
    settings: GuardSettings,
    controlPaths: readonly string[] = [],
    trustedExtensionPaths: readonly string[] = [],
): Promise<PermissionProfile> {
    const workspace = await canonicalPath(cwd, cwd);
    // Codex workspace-write reads everything; only guard control and rule files stay hidden.
    const hardRead = [...controlPaths, ...settings.ruleFiles];
    const hardWrite = [
        ...hardRead,
        join(workspace, ".pi", "guard"),
        fileURLToPath(new URL("../", import.meta.url)),
    ];
    const roots = [
        ...new Set(
            await Promise.all(
                [
                    workspace,
                    ...settings.writableRoots,
                    ...(!settings.excludeSlashTmp ? ["/tmp"] : []),
                    ...(!settings.excludeTmpdir ? [tmpdir()] : []),
                ].map((path) => canonicalPath(path, cwd)),
            ),
        ),
    ];
    const readOnlyPaths: string[] = [];
    for (const input of trustedExtensionPaths) {
        const path = await canonicalPath(input, cwd);
        // A trusted module can import sibling modules; protect its containing code directory.
        hardWrite.push((await stat(path)).isDirectory() ? path : dirname(path));
    }
    for (const root of roots) {
        const git = join(root, ".git");
        readOnlyPaths.push(await canonicalPath(git, cwd));
        try {
            if ((await stat(git)).isFile()) {
                const pointer = /^gitdir:\s*(.+)\s*$/m.exec(
                    await readFile(git, "utf8"),
                );
                if (pointer?.[1])
                    readOnlyPaths.push(
                        await canonicalPath(resolve(root, pointer[1]), cwd),
                    );
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        for (const name of [".agents", ".codex", ".aws"]) {
            const path = join(root, name);
            try {
                if ((await stat(path)).isDirectory())
                    readOnlyPaths.push(await canonicalPath(path, cwd));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
        }
        // Like Codex project .codex metadata, project .pi edits go through approval review.
        readOnlyPaths.push(await canonicalPath(join(root, ".pi"), cwd));
        hardWrite.push(join(root, ".pi", "guard"));
    }
    return createProfile({
        mode: settings.mode,
        readRoots: ["/"],
        writeRoots: settings.mode === "workspace-write" ? roots : [],
        denyRead: await Promise.all(hardRead.map((p) => canonicalPath(p, cwd))),
        denyWrite: await Promise.all(
            hardWrite.map((p) => canonicalPath(p, cwd)),
        ),
        readOnlyPaths,
        allowedDomains: [...settings.allowedDomains],
        deniedDomains: [],
    });
}
export class PolicyEngine {
    private rules: readonly PrefixRule[];
    private isInitialized: boolean;
    private ruleSources: readonly RuleSource[] = [];
    private compiledRules?: CompiledRules;
    private readonly matchCache = new Map<
        string,
        readonly (readonly RuleMatch[])[]
    >();
    private effectiveProfile: PermissionProfile;
    get profile(): PermissionProfile {
        return this.effectiveProfile;
    }
    get revision(): string {
        return digest({
            settings: this.settings,
            profile: this.profile,
            rules: this.rules,
            ruleSources: this.ruleSources,
            compiledRules: this.compiledRules ?? null,
            reviewPolicyDigest: reviewPolicy(this.settings.reviewPolicy).digest,
        });
    }
    constructor(
        readonly settings: GuardSettings,
        profile: PermissionProfile,
    ) {
        this.effectiveProfile = profile;
        this.rules = settings.commandRules.map((rule) => ({
            pattern: rule.prefix,
            decision:
                rule.decision === "ask"
                    ? "prompt"
                    : rule.decision === "deny"
                      ? "forbidden"
                      : "allow",
        }));
        this.isInitialized = settings.ruleFiles.length === 0;
    }
    async initialize(cwd = process.cwd()): Promise<void> {
        if (this.isInitialized) return;
        this.ruleSources = immutable(
            await Promise.all(
                this.settings.ruleFiles.map(async (path) => ({
                    name: resolve(cwd, path),
                    source: await readFile(resolve(cwd, path), "utf8"),
                })),
            ),
        );
        this.compiledRules = await evaluateRules(this.ruleSources);
        const allowed = this.compiledRules.allowedDomains,
            denied = this.compiledRules.deniedDomains;
        this.effectiveProfile = createProfile({
            ...this.profile,
            allowedDomains: [
                ...new Set([
                    ...this.profile.allowedDomains.filter(
                        (host) => !denied.includes(host),
                    ),
                    ...allowed,
                ]),
            ],
            deniedDomains: [
                ...new Set([...this.profile.deniedDomains, ...denied]),
            ],
        });
        this.isInitialized = true;
    }
    async evaluate(
        action: GuardAction,
        signal?: AbortSignal,
    ): Promise<PolicyDecision> {
        if (!this.isInitialized)
            return decision(
                action,
                "deny",
                "Command rules have not been loaded",
                EMPTY_DELTA,
                true,
            );
        if (
            action.policyRevision !== this.revision ||
            action.permissionDigest !== digest(this.profile)
        )
            return decision(
                action,
                "deny",
                "Stale policy or permission profile",
                EMPTY_DELTA,
                true,
            );
        if (!TOOL_NAMES.includes(action.tool as never))
            return decision(
                action,
                "ask",
                "Unknown tool: annotations do not establish permission",
            );
        if (action.tool === "bash") return this.shellDecision(action, signal);
        const input = action.args.path ?? action.cwd;
        if (typeof input !== "string")
            return decision(
                action,
                "deny",
                "Invalid path input",
                EMPTY_DELTA,
                true,
            );
        const target = await canonicalPath(
            await resolveToolPath(input, action.cwd, action.tool === "read"),
            action.cwd,
        );
        const profile = await this.resolvedProfile(action.cwd);
        const isWrite = action.tool === "write" || action.tool === "edit";
        if (
            profile.denyRead.some((p) => isWithin(target, p)) ||
            (isWrite && profile.denyWrite.some((p) => isWithin(target, p)))
        )
            return decision(
                action,
                "deny",
                "Protected path",
                EMPTY_DELTA,
                true,
            );
        const canRead = profile.readRoots.some((p) => isWithin(target, p));
        const canWrite =
            !isWrite ||
            (profile.writeRoots.some((p) => isWithin(target, p)) &&
                !(profile.readOnlyPaths ?? []).some((p) =>
                    isWithin(target, p),
                ));
        if (canRead && canWrite)
            return decision(
                action,
                "allow",
                "Within current filesystem permissions",
            );
        return decision(
            action,
            "ask",
            "Action outside the ordinary approval scope",
            {
                readPaths: canRead ? [] : [target],
                writePaths: canWrite ? [] : [target],
                domains: [],
            },
        );
    }
    private async shellDecision(
        action: GuardAction,
        signal?: AbortSignal,
    ): Promise<PolicyDecision> {
        const profile = await this.resolvedProfile(action.cwd);
        const command = action.args.command;
        if (typeof command !== "string")
            return decision(
                action,
                "deny",
                "Invalid command input",
                EMPTY_DELTA,
                true,
            );
        const analysis = analyzeShell(command);
        let shouldAsk = !analysis.isSupported;
        const delta: {
            readPaths: string[];
            writePaths: string[];
            domains: string[];
        } = { readPaths: [], writePaths: [], domains: [] };
        const commandGroups = ruleCommands(
            command,
            typeof action.args.shellPath === "string"
                ? action.args.shellPath
                : "/bin/bash",
        );
        const key = digest(commandGroups);
        let compiledMatches = this.matchCache.get(key);
        if (!compiledMatches && this.ruleSources.length) {
            compiledMatches = (
                await evaluateRules(this.ruleSources, commandGroups, signal)
            ).matches;
            if (this.matchCache.size >= 256) {
                const oldestKey = this.matchCache.keys().next().value;
                if (oldestKey !== undefined) this.matchCache.delete(oldestKey);
            }
            this.matchCache.set(key, compiledMatches);
        }
        const matches = commandGroups.map((argv, index) => [
            ...this.rules.filter((rule) => matchesRule(argv, rule)),
            ...(compiledMatches?.[index] ?? []),
        ]);
        const forbidden = matches
            .flat()
            .find((rule) => rule.decision === "forbidden");
        if (forbidden)
            return decision(
                action,
                "deny",
                forbidden.justification ?? "Command forbidden by trusted rule",
                EMPTY_DELTA,
                true,
            );
        const prompted = matches
            .flat()
            .find((rule) => rule.decision === "prompt");
        const isRuleAllowed =
            !prompted &&
            matches.length > 0 &&
            matches.every((group) =>
                group.some((rule) => rule.decision === "allow"),
            );
        if (prompted) shouldAsk = true;
        if (
            action.args.sandbox_permissions !== undefined &&
            !["use_default", "require_escalated"].includes(
                String(action.args.sandbox_permissions),
            )
        )
            return decision(
                action,
                "deny",
                "Invalid sandbox permission request",
                EMPTY_DELTA,
                true,
            );
        const explicit = action.args.additional_permissions;
        if (explicit !== undefined) {
            if (
                !explicit ||
                typeof explicit !== "object" ||
                Array.isArray(explicit) ||
                Object.keys(explicit).some(
                    (key) =>
                        !["readPaths", "writePaths", "domains"].includes(key),
                )
            )
                return decision(
                    action,
                    "deny",
                    "Invalid additional permissions",
                    EMPTY_DELTA,
                    true,
                );
            for (const key of ["readPaths", "writePaths", "domains"] as const) {
                const values = explicit[key] ?? [];
                if (
                    !Array.isArray(values) ||
                    values.some(
                        (value) =>
                            typeof value !== "string" ||
                            !value ||
                            value.includes("\0"),
                    )
                )
                    return decision(
                        action,
                        "deny",
                        "Invalid permission list",
                        EMPTY_DELTA,
                        true,
                    );
                delta[key].push(...(values as string[]));
            }
            shouldAsk = true;
        }
        for (const item of analysis.commands) {
            const executable = basename(item.argv[0] ?? "");
            const isSafeRead = [
                "pwd",
                "echo",
                "printf",
                "ls",
                "cat",
                "head",
                "tail",
                "wc",
                "rg",
                "grep",
                "find",
                "stat",
                "true",
                "false",
            ].includes(executable);
            if (
                !isSafeRead &&
                ![
                    "touch",
                    "mkdir",
                    "rmdir",
                    "rm",
                    "truncate",
                    "tee",
                    "chmod",
                    "chown",
                    "cp",
                    "mv",
                    "git",
                    "curl",
                    "wget",
                ].includes(executable)
            )
                shouldAsk = true;
            const operands = item.argv
                .slice(1)
                .filter((arg) => !arg.startsWith("-"));
            const reads = [...item.reads],
                writes = [...item.writes];
            if (analysis.isSupported) {
                if (
                    isSafeRead &&
                    !["echo", "printf", "true", "false", "pwd"].includes(
                        executable,
                    )
                )
                    reads.push(...operands);
                if (
                    [
                        "touch",
                        "mkdir",
                        "rmdir",
                        "rm",
                        "truncate",
                        "tee",
                        "chmod",
                        "chown",
                    ].includes(executable)
                )
                    writes.push(...operands);
                if (["cp", "mv"].includes(executable)) {
                    reads.push(...operands.slice(0, -1));
                    writes.push(...operands.slice(-1));
                    if (executable === "mv")
                        writes.push(...operands.slice(0, -1));
                }
                if (
                    executable === "git" &&
                    ![
                        "status",
                        "diff",
                        "log",
                        "show",
                        "ls-files",
                        "rev-parse",
                    ].includes(item.argv[1] ?? "")
                )
                    writes.push(
                        ...(profile.readOnlyPaths ?? []).filter(
                            (path) =>
                                path === join(action.cwd, ".git") ||
                                path.includes("/.git/"),
                        ),
                    );
            }
            for (const path of writes) {
                const target = await canonicalPath(path, action.cwd);
                if (
                    [...profile.denyRead, ...profile.denyWrite].some((root) =>
                        isWithin(target, root),
                    )
                )
                    return decision(
                        action,
                        "deny",
                        "Command writes a protected path",
                        EMPTY_DELTA,
                        true,
                    );
                if (
                    !profile.writeRoots.some((root) =>
                        isWithin(target, root),
                    ) ||
                    (profile.readOnlyPaths ?? []).some((root) =>
                        isWithin(target, root),
                    )
                ) {
                    shouldAsk = true;
                    delta.writePaths.push(target);
                }
            }
            for (const path of reads) {
                const target = await canonicalPath(path, action.cwd);
                if (profile.denyRead.some((root) => isWithin(target, root)))
                    return decision(
                        action,
                        "deny",
                        "Command reads a protected path",
                        EMPTY_DELTA,
                        true,
                    );
                if (!profile.readRoots.some((root) => isWithin(target, root))) {
                    shouldAsk = true;
                    delta.readPaths.push(target);
                }
            }
            if (analysis.isSupported && ["curl", "wget"].includes(executable)) {
                const urls = item.argv
                    .slice(1)
                    .filter((arg) => /^https?:\/\//.test(arg));
                // A destination hidden in a config file or a schemeless URL still needs review.
                const hasIndirectDestination = item.argv
                    .slice(1)
                    .some((arg) =>
                        executable === "curl"
                            ? /^(?:--config(?:=|$)|-K)/.test(arg)
                            : /^(?:--input-file(?:=|$)|-i)/.test(arg),
                    );
                if (!urls.length || hasIndirectDestination) shouldAsk = true;
                for (const text of urls) {
                    const domain = normalizeHost(new URL(text).hostname);
                    if (
                        profile.deniedDomains.some((pattern) =>
                            matchesDomain(domain, pattern),
                        )
                    )
                        return decision(
                            action,
                            "deny",
                            "Network domain denied",
                            EMPTY_DELTA,
                            true,
                        );
                    if (
                        !profile.allowedDomains.some((pattern) =>
                            matchesDomain(domain, pattern),
                        )
                    ) {
                        delta.domains.push(domain);
                        shouldAsk = true;
                    }
                }
            }
        }
        for (const key of ["readPaths", "writePaths"] as const)
            delta[key] = [
                ...new Set(
                    await Promise.all(
                        delta[key].map((path) =>
                            canonicalPath(path, action.cwd),
                        ),
                    ),
                ),
            ];
        if (
            delta.readPaths.some((path) =>
                profile.denyRead.some((root) => isWithin(path, root)),
            ) ||
            delta.writePaths.some((path) =>
                [...profile.denyRead, ...profile.denyWrite].some((root) =>
                    isWithin(path, root),
                ),
            ) ||
            delta.domains.some(
                (host) =>
                    !isNetworkHost(host) ||
                    profile.deniedDomains.some((pattern) =>
                        matchesDomain(host, pattern),
                    ),
            )
        )
            return decision(
                action,
                "deny",
                "Requested permissions target an absolute deny",
                EMPTY_DELTA,
                true,
            );
        const boundDelta = {
            ...delta,
            domains: [...new Set(delta.domains.map(normalizeHost))],
        };
        if (isRuleAllowed)
            return immutable({
                ...decision(
                    action,
                    "allow",
                    "Trusted prefix rule authorizes this command",
                    boundDelta,
                ),
                authority: {
                    kind: "command-rule",
                    actionDigest: action.digest,
                    ruleDigest: digest(matches),
                },
            });
        const isFullRequest =
            action.args.sandbox_permissions === "require_escalated" &&
            explicit === undefined;
        shouldAsk ||= action.args.sandbox_permissions === "require_escalated";
        const reason =
            prompted?.justification ??
            (shouldAsk
                ? "Command requires approval review"
                : "Within the ordinary approval scope");
        return immutable({
            ...decision(
                action,
                shouldAsk ? "ask" : "allow",
                reason,
                boundDelta,
            ),
            approvalCategory: prompted ? "rules" : "sandbox",
            ...(isFullRequest
                ? {
                      authority: {
                          kind: "reviewed-command",
                          actionDigest: action.digest,
                      },
                  }
                : {}),
        });
    }
    private async resolvedProfile(cwd: string): Promise<PermissionProfile> {
        const result = { ...this.profile };
        for (const key of [
            "readRoots",
            "writeRoots",
            "denyRead",
            "denyWrite",
        ] as const)
            result[key] = await Promise.all(
                this.profile[key].map((path) => canonicalPath(path, cwd)),
            );
        if (this.profile.readOnlyPaths)
            result.readOnlyPaths = await Promise.all(
                this.profile.readOnlyPaths.map((path) =>
                    canonicalPath(path, cwd),
                ),
            );
        return result;
    }
}
