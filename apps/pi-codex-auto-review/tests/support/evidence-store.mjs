import { createHash, randomUUID } from "node:crypto";
import {
    link,
    mkdir,
    readdir,
    readFile,
    unlink,
    writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repository = fileURLToPath(new URL("../../", import.meta.url));
export const reportRoot = join(repository, ".reports/pi-guard");
export const requiredPlatforms = ["darwin-arm64", "linux-x64"];

/** Publish complete bytes atomically; existing evidence is never replaceable. */
export async function writeImmutable(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const data =
        typeof value === "string" || Buffer.isBuffer(value)
            ? value
            : `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(temporary, data, { flag: "wx" });
    try {
        await link(temporary, path);
    } finally {
        await unlink(temporary);
    }
}

export async function createRun({
    platform = `${process.platform}-${process.arch}`,
    base = reportRoot,
    ...metadata
} = {}) {
    if (!/^[a-z0-9]+-[a-z0-9]+$/.test(platform))
        throw new Error("Invalid evidence platform");
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const directory = join(base, "runs", runId, platform);
    await mkdir(directory, { recursive: true });
    const run = {
        runId,
        platform,
        directory,
        artifactPath: relative(repository, directory).split(sep).join("/"),
        recordedAt: new Date().toISOString(),
        ...metadata,
    };
    await writeImmutable(join(directory, "started.json"), {
        schemaVersion: 2,
        ...run,
    });
    return run;
}

/** Preserve old bytes, including unknown provenance, before refreshing compatibility views. */
export async function preserveLegacy() {
    const archive = join(reportRoot, "archives", `legacy-${randomUUID()}`);
    const inventory = [];
    for (const location of [".reports/pi-guard", "../../docs/verification/pi-guard"]) {
        let entries;
        try {
            entries = await readdir(join(repository, location), {
                withFileTypes: true,
            });
        } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const path = join(location, entry.name),
                data = await readFile(join(repository, path));
            const targetDirectory = join(archive, location);
            await mkdir(targetDirectory, { recursive: true });
            await writeImmutable(join(targetDirectory, entry.name), data);
            inventory.push({
                path,
                sha256: createHash("sha256").update(data).digest("hex"),
                size: data.length,
            });
        }
    }
    await mkdir(archive, { recursive: true });
    await writeImmutable(join(archive, "inventory.json"), {
        kind: "preserved-legacy",
        files: inventory,
    });
    return relative(repository, archive);
}

export async function platformCandidates(platform) {
    let entries;
    try {
        entries = await readdir(join(reportRoot, "runs"));
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
    const candidates = [];
    for (const id of entries.sort().reverse()) {
        try {
            candidates.push(
                JSON.parse(
                    await readFile(
                        join(reportRoot, "runs", id, platform, "platform.json"),
                        "utf8",
                    ),
                ),
            );
        } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
                throw error;
        }
    }
    // Legacy records are readable, but callers must require provenance for qualification.
    try {
        candidates.push(
            JSON.parse(
                await readFile(
                    join(reportRoot, `platform-${platform}.json`),
                    "utf8",
                ),
            ),
        );
    } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
            throw error;
    }
    return candidates;
}
