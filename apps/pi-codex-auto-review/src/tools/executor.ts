import {
    access,
    mkdir,
    readdir,
    readFile,
    stat,
    writeFile,
} from "node:fs/promises";
import {
    createEditToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLocalBashOperations,
    createLsToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
    type ExecutionOptions,
    GuardError,
    type Json,
    type PermissionDelta,
    type PermissionProfile,
    type WorkerJob,
} from "../contracts.js";

export interface ToolExecutor {
    execute(
        job: WorkerJob,
        profile: PermissionProfile,
        delta: PermissionDelta,
        options?: ExecutionOptions,
    ): Promise<Json>;
    close(): Promise<void>;
}

/** Approval is handled by the controller; Pi owns ordinary tool execution. */
export class PiExecutor implements ToolExecutor {
    private readonly stopped = new AbortController();
    private readonly active = new Set<Promise<unknown>>();
    get activeInvocationCount(): number {
        return this.active.size;
    }

    async execute(
        job: WorkerJob,
        _profile: PermissionProfile,
        _delta: PermissionDelta,
        options: ExecutionOptions = {},
    ): Promise<Json> {
        const signal = AbortSignal.any([
            this.stopped.signal,
            ...(options.signal ? [options.signal] : []),
        ]);
        signal.throwIfAborted();
        const task = this.run(job, options, signal);
        this.active.add(task);
        try {
            return await task;
        } finally {
            this.active.delete(task);
        }
    }

    private async run(
        job: WorkerJob,
        options: ExecutionOptions,
        signal: AbortSignal,
    ): Promise<Json> {
        if (options.delegate) return options.delegate(signal);
        if (job.kind === "shell") {
            const result = await createLocalBashOperations({
                shellPath: job.shellPath,
            }).exec(job.command, job.cwd, {
                signal,
                timeout: options.timeoutSeconds ?? job.timeoutSeconds,
                env: options.env ?? job.env,
                onData: options.onData ?? (() => {}),
            });
            return result as unknown as Json;
        }
        if (job.kind === "file") {
            let result: Json;
            switch (job.operation) {
                case "read":
                    result = {
                        data: (await readFile(job.path, { signal })).toString(
                            "base64",
                        ),
                    };
                    break;
                case "write":
                    await writeFile(job.path, job.content ?? "", { signal });
                    result = null;
                    break;
                case "mkdir":
                    await mkdir(job.path, { recursive: true });
                    result = null;
                    break;
                case "access":
                    await access(job.path);
                    result = null;
                    break;
                case "stat":
                    result = {
                        isDirectory: (await stat(job.path)).isDirectory(),
                    };
                    break;
                case "list":
                    result = await readdir(job.path);
                    break;
                default:
                    throw new GuardError(
                        "INVALID_EXECUTION",
                        "Unknown file operation",
                    );
            }
            signal.throwIfAborted();
            return result;
        }
        const factories = {
            read: createReadToolDefinition,
            write: createWriteToolDefinition,
            edit: createEditToolDefinition,
            grep: createGrepToolDefinition,
            find: createFindToolDefinition,
            ls: createLsToolDefinition,
        };
        if (job.tool === "bash")
            throw new GuardError(
                "INVALID_EXECUTION",
                "Use the shell execution path",
            );
        const definition = factories[job.tool](
            job.cwd,
            job.tool === "read" ? job.options : undefined,
        );
        return (await definition.execute(
            job.toolCallId,
            job.args as never,
            signal,
            options.onUpdate as never,
            undefined as never,
        )) as unknown as Json;
    }

    async close(): Promise<void> {
        this.stopped.abort(
            new GuardError("CANCELLED", "Tool execution stopped"),
        );
        await Promise.allSettled([...this.active]);
    }
}
