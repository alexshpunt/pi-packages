#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    InteractiveMode,
    runPrintMode,
    runRpcMode,
} from "@earendil-works/pi-coding-agent";
import { createGuardedRuntime } from "./startup.js";

export async function main(argv: string[]): Promise<void> {
    let mode = "tui",
        cwd = process.cwd(),
        agentDir =
            process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
        settingsPath: string | undefined,
        isProjectTrusted: boolean | undefined;
    let provider: string | undefined, modelId: string | undefined;
    const prompts: string[] = [],
        trustedExtensionPaths: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        if (item === undefined) continue;
        if (item === "--help" || item === "-h") {
            console.log(
                "Usage: pi-codex-auto-review [--cwd path] [--agent-dir path] [--policy file] [--trust-project] [--extension path ...] [--provider provider --model model] [--mode tui|print|json|rpc] [prompt]\n--extension (-e) can be repeated. It trusts each code directory and rejects direct model tool writes to it. Paths are resolved from the invocation directory.",
            );
            return;
        }
        if (item === "--") {
            prompts.push(...argv.slice(i + 1));
            break;
        }
        if (item === "--trust-project") {
            isProjectTrusted = true;
            continue;
        }
        if (
            [
                "--mode",
                "--cwd",
                "--agent-dir",
                "--policy",
                "--extension",
                "-e",
                "--provider",
                "--model",
            ].includes(item)
        ) {
            const value = argv[++i];
            if (!value || value.startsWith("--"))
                throw new Error(`${item}: a value is required`);
            if (item === "--mode") mode = value;
            if (item === "--cwd") cwd = value;
            if (item === "--agent-dir") agentDir = value;
            if (item === "--policy") settingsPath = value;
            if (item === "--extension" || item === "-e")
                trustedExtensionPaths.push(resolve(value));
            if (item === "--provider") provider = value;
            if (item === "--model") modelId = value;
        } else if (item === "-p") mode = "print";
        else if (item.startsWith("-"))
            throw new Error(`Unsupported option: ${item}`);
        else prompts.push(item);
    }
    if (!["tui", "print", "json", "rpc"].includes(mode))
        throw new Error(`Unsupported mode: ${mode}`);
    if (Boolean(provider) !== Boolean(modelId))
        throw new Error("--provider and --model must be specified together");
    const runtime = await createGuardedRuntime({
        cwd: resolve(cwd),
        agentDir: resolve(agentDir),
        settingsPath: settingsPath ? resolve(settingsPath) : undefined,
        isProjectTrusted,
        trustedExtensionPaths,
        ...(provider && modelId
            ? { modelSelection: { provider, id: modelId } }
            : {}),
    });
    try {
        if (mode === "rpc") await runRpcMode(runtime);
        else if (mode === "tui")
            await new InteractiveMode(runtime, {
                initialMessage: prompts.join(" ") || undefined,
            }).run();
        else
            process.exitCode = await runPrintMode(runtime, {
                mode: mode === "json" ? "json" : "text",
                initialMessage: prompts.join(" ") || undefined,
            });
    } finally {
        await runtime.dispose();
    }
}
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
    main(process.argv.slice(2)).catch((error) => {
        console.error(`pi-codex-auto-review: ${(error as Error).message}`);
        process.exitCode = 1;
    });
