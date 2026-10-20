import { createHash, randomUUID } from "node:crypto";
import {
    lstat,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
    canonicalJson,
    digest,
    GuardError,
    immutable,
    type PolicyDecision,
} from "./contracts.js";
import { canonicalPath, resolveToolPath } from "./policy/paths.js";
import { analyzeShell } from "./policy/shell.js";

/** An approved MCP tool or skill version; the same content skips a repeated review. */
export interface PackageApproval {
    /** Identity without version, so approving a new version replaces the old one. */
    readonly packageKey: string;
    /** Identity plus version and content. */
    readonly fingerprint: string;
}
export type PackageApprovalScope = "session" | "persistent";

const SCRIPT_INTERPRETERS = new Set([
    "bash",
    "bun",
    "deno",
    "node",
    "perl",
    "python",
    "python3",
    "ruby",
    "sh",
    "zsh",
]);
const MAX_SKILL_ROOT_DEPTH = 6;
const MAX_SKILL_FILES = 2000;
const MAX_SKILL_BYTES = 64 * 1024 * 1024;
const fileDigests = new Map<
    string,
    { size: number; mtimeMs: number; ino: number; sha256: string }
>();

/**
 * Only the "may this package run?" question is cached. Extra paths, network domains,
 * escalation, rule prompts, strict MCP review and user-input requests are reviewed again.
 */
export function isPackageCacheEligible(policy: PolicyDecision): boolean {
    return (
        policy.kind === "ask" &&
        policy.approvalCategory !== "rules" &&
        policy.requiresFreshReview !== true &&
        policy.requiresUserInput !== true &&
        policy.authority === undefined &&
        policy.delta.readPaths.length === 0 &&
        policy.delta.writePaths.length === 0 &&
        policy.delta.domains.length === 0
    );
}

export function mcpPackageApproval(input: {
    readonly server: string;
    readonly tool: string;
    readonly configDigest: string;
    readonly serverInfo: unknown;
    readonly definition: unknown;
}): PackageApproval {
    return {
        packageKey: digest({
            kind: "mcp",
            server: input.server,
            tool: input.tool,
        }),
        fingerprint: digest({
            kind: "mcp",
            server: input.server,
            tool: input.tool,
            configDigest: input.configDigest,
            serverInfo: JSON.parse(JSON.stringify(input.serverInfo ?? null)),
            definition: JSON.parse(JSON.stringify(input.definition ?? null)),
        }),
    };
}

/** A single `<script>` or `<interpreter> <script>` command whose script lives in a skill directory. */
export async function skillPackageApproval(
    command: string,
    cwd: string,
): Promise<PackageApproval | undefined> {
    let analysis: ReturnType<typeof analyzeShell>;
    try {
        analysis = analyzeShell(command);
    } catch {
        return undefined;
    }
    if (!analysis.isSupported || analysis.commands.length !== 1)
        return undefined;
    const [executable = "", firstArgument] = analysis.commands[0].argv;
    const script = executable.includes("/")
        ? executable
        : SCRIPT_INTERPRETERS.has(basename(executable))
          ? firstArgument
          : undefined;
    if (!script || script.startsWith("-")) return undefined;
    const target = await canonicalPath(await resolveToolPath(script, cwd), cwd);
    if (!(await stat(target).catch(() => undefined))?.isFile())
        return undefined;
    const root = await findSkillRoot(dirname(target));
    if (!root) return undefined;
    const contentDigest = await directoryDigest(root);
    if (!contentDigest) return undefined;
    return {
        packageKey: digest({ kind: "skill", root }),
        fingerprint: digest({ kind: "skill", root, contentDigest }),
    };
}

async function findSkillRoot(start: string): Promise<string | undefined> {
    let directory = start;
    for (let depth = 0; depth < MAX_SKILL_ROOT_DEPTH; depth++) {
        if (
            (
                await stat(join(directory, "SKILL.md")).catch(() => undefined)
            )?.isFile()
        )
            return directory;
        const parent = dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
    }
    return undefined;
}

/** Symlinks and oversized trees are never cached because their content cannot be pinned. */
async function directoryDigest(root: string): Promise<string | undefined> {
    const files: { path: string; sha256: string }[] = [];
    let totalBytes = 0;
    const pending = [root];
    while (pending.length) {
        const directory = pending.pop() as string;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                pending.push(path);
                continue;
            }
            if (!entry.isFile()) return undefined;
            const info = await lstat(path);
            totalBytes += info.size;
            if (files.length >= MAX_SKILL_FILES || totalBytes > MAX_SKILL_BYTES)
                return undefined;
            const known = fileDigests.get(path);
            let sha256 = known?.sha256;
            if (
                !known ||
                known.size !== info.size ||
                known.mtimeMs !== info.mtimeMs ||
                known.ino !== info.ino
            ) {
                sha256 = createHash("sha256")
                    .update(await readFile(path))
                    .digest("hex");
                fileDigests.set(path, {
                    size: info.size,
                    mtimeMs: info.mtimeMs,
                    ino: info.ino,
                    sha256,
                });
            }
            files.push({
                path: relative(root, path),
                sha256: sha256 as string,
            });
        }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return digest(files);
}

export class PackageApprovalStore {
    private persistent: PackageApproval[] = [];
    private readonly session = new Set<string>();
    private writes: Promise<void> = Promise.resolve();
    constructor(readonly path: string) {}
    async load(): Promise<void> {
        try {
            const data: unknown = JSON.parse(await readFile(this.path, "utf8"));
            if (
                !Array.isArray(data) ||
                data.some(
                    (value) =>
                        typeof value?.packageKey !== "string" ||
                        typeof value?.fingerprint !== "string" ||
                        Object.keys(value).length !== 2,
                )
            )
                throw new Error("Invalid package approvals");
            this.persistent = immutable(data as PackageApproval[]);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw new GuardError(
                "INVALID_PACKAGE_APPROVALS",
                "Package approvals could not be loaded",
                { cause: error },
            );
        }
    }
    has(approval: PackageApproval, sessionId: string): boolean {
        return (
            this.session.has(`${sessionId}\0${approval.fingerprint}`) ||
            this.persistent.some(
                (item) => item.fingerprint === approval.fingerprint,
            )
        );
    }
    async remember(
        approval: PackageApproval,
        scope: PackageApprovalScope,
        sessionId: string,
    ): Promise<void> {
        if (scope === "session") {
            this.session.add(`${sessionId}\0${approval.fingerprint}`);
            return;
        }
        const task = this.writes.then(async () => {
            const next = [
                ...this.persistent.filter(
                    (item) => item.packageKey !== approval.packageKey,
                ),
                {
                    packageKey: approval.packageKey,
                    fingerprint: approval.fingerprint,
                },
            ];
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            const temporary = `${this.path}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, `${canonicalJson(next)}\n`, {
                    mode: 0o600,
                    flag: "wx",
                });
                await rename(temporary, this.path);
            } finally {
                await rm(temporary, { force: true });
            }
            this.persistent = immutable(next);
        });
        this.writes = task.catch(() => {});
        await task;
    }
}
