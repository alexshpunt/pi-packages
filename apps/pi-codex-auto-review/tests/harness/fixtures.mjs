import { randomUUID } from "node:crypto";
import {
    appendFile,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAction,
    createProfile,
} from "../../dist/contracts.js";

export const auditDirectory =
    process.env.PI_GUARD_RUN_DIR ??
    new URL(
        `../../.reports/pi-guard/runs/direct-${randomUUID()}/${process.platform}-${process.arch}/`,
        import.meta.url,
    ).pathname;
export const auditPopulationPath = join(auditDirectory, "owned-audits.jsonl");

export async function fixture(t) {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "pi-guard-test-")),
    );
    const workspace = join(root, "workspace"),
        outside = join(root, "outside"),
        control = join(root, "control"),
        agentDir = join(control, "agent");
    await Promise.all(
        [workspace, outside, agentDir].map((p) =>
            mkdir(p, { recursive: true }),
        ),
    );
    const secret = `SYNTHETIC_GUARD_SECRET_${randomUUID()}`;
    await writeFile(join(control, "protected.txt"), secret);
    await writeFile(join(outside, "sentinel.txt"), "unchanged");
    t.onTestFinished(async () => {
        try {
            for (const path of [
                join(control, "audit.jsonl"),
                join(agentDir, "guard/audit.jsonl"),
            ]) {
                let text;
                try {
                    text = await readFile(path, "utf8");
                } catch (error) {
                    if (error.code === "ENOENT") continue;
                    throw error;
                }
                if (!text.trim()) throw new Error("Audit population is empty");
                if (text.includes(secret))
                    throw new Error(
                        "Audit contains the full owned synthetic marker",
                    );
                await mkdir(auditDirectory, { recursive: true });
                await appendFile(auditPopulationPath, text);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    const profile = createProfile({
        mode: "workspace-write",
        readRoots: [workspace],
        writeRoots: [workspace],
        denyRead: [control],
        denyWrite: [control],
        allowedDomains: [],
        deniedDomains: [],
    });
    const action = (tool, args, extra = {}) =>
        createAction(
            {
                toolCallId: randomUUID(),
                tool,
                source: "model",
                args,
                cwd: workspace,
                sessionId: "fixture-session",
                policyRevision: "fixture-policy",
                ...extra,
            },
            profile,
        );
    return {
        root,
        workspace,
        outside,
        control,
        agentDir,
        secret,
        profile,
        action,
    };
}

export class ControlledClock {
    nowMs = 0;
    #next = 0;
    #tasks = new Map();
    setTimeout = (fn, delayMs) => {
        const id = ++this.#next;
        this.#tasks.set(id, { fn, at: this.nowMs + delayMs });
        return id;
    };
    clearTimeout = (id) => {
        this.#tasks.delete(id);
    };
    advance(delayMs) {
        this.nowMs += delayMs;
        for (const [id, task] of [...this.#tasks])
            if (task.at <= this.nowMs) {
                this.#tasks.delete(id);
                task.fn();
            }
    }
}
