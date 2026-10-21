import { randomUUID } from "node:crypto";
import {
    mkdir,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    rmdir,
    stat,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 30000;
const LOCK_RETRY_MS = 25;
const pendingWrites = new Map<string, Promise<void>>();
// Windows reports renaming onto an existing directory as a permission error.
const LOCK_BUSY_CODES =
    process.platform === "win32"
        ? ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"]
        : ["EEXIST", "ENOTEMPTY"];

function hasCode(error: unknown, ...codes: string[]): boolean {
    return codes.includes((error as NodeJS.ErrnoException).code ?? "");
}

async function removeEmptyLock(path: string): Promise<void> {
    try {
        await rmdir(path);
    } catch (error) {
        if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error;
    }
}

async function removeStaleLock(path: string): Promise<void> {
    try {
        const entries = await readdir(path);
        if (entries.length !== 1) return;
        const owner = entries[0];
        if (!/^owner-[\da-f-]+$/.test(owner)) return;
        const ownerPath = join(path, owner);
        const info = await stat(ownerPath);
        if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;
        const pid = Number(await readFile(ownerPath, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0) return;
        try {
            process.kill(pid, 0);
            return;
        } catch (error) {
            if (!hasCode(error, "ESRCH")) return;
        }
        // Remove only this owner's record. A successor has a different record
        // and a nonempty directory, so competing stale-lock cleanup cannot steal it.
        await rm(ownerPath, { force: true });
        await removeEmptyLock(path);
    } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
    }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
    const candidate = `${path}.${randomUUID()}.tmp`;
    const owner = `owner-${randomUUID()}`;
    await mkdir(candidate, { mode: 0o700 });
    try {
        await writeFile(join(candidate, owner), String(process.pid), {
            flag: "wx",
            mode: 0o600,
        });
        const deadline = performance.now() + LOCK_TIMEOUT_MS;
        for (;;) {
            try {
                // Publish a nonempty lock directory atomically. Unlike an empty
                // directory, an owned lock cannot be replaced by rename.
                await rename(candidate, path);
                return async () => {
                    await rm(join(path, owner), { force: true });
                    await removeEmptyLock(path);
                };
            } catch (error) {
                if (!hasCode(error, ...LOCK_BUSY_CODES)) throw error;
            }
            await removeStaleLock(path);
            const remaining = deadline - performance.now();
            if (remaining <= 0)
                throw new Error(
                    `Timed out waiting for Fast settings lock: ${path}`,
                );
            await delay(Math.min(LOCK_RETRY_MS, remaining));
        }
    } finally {
        await rm(candidate, { recursive: true, force: true });
    }
}

/** Serialize the entire read/modify/write transaction, including other Pi processes. */
export async function withSettingsLock(
    path: string,
    write: (path: string) => Promise<void>,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const target = join(await realpath(dirname(path)), basename(path));
    const previous = pendingWrites.get(target) ?? Promise.resolve();
    const pending = previous
        .catch(() => {})
        .then(async () => {
            const release = await acquireLock(`${target}.lock`);
            try {
                await write(target);
            } finally {
                await release();
            }
        });
    pendingWrites.set(target, pending);
    try {
        await pending;
    } finally {
        if (pendingWrites.get(target) === pending) pendingWrites.delete(target);
    }
}
