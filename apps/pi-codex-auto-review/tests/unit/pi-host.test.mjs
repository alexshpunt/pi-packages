import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({ directory: "" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getPackageDir: () => host.directory }));
const { shellIdentity } = await import("../../dist/pi-host.js");

test("[pi-host] preserves a resolver's bare sh identity and uses a deterministic unresolved marker on failure", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-shell-host-"));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    for (const [name, source, expected] of [
        ["bare", 'export const getShellConfig = () => ({ shell: "sh", args: ["-c"] });', "sh"],
        ["unavailable", "export const other = true;", "pi-default-shell-unresolved"],
        ["failure", 'export const getShellConfig = () => { throw new Error("No shell"); };', "pi-default-shell-unresolved"],
    ]) {
        host.directory = join(root, name);
        await mkdir(join(host.directory, "dist/utils"), { recursive: true });
        await writeFile(join(host.directory, "package.json"), '{"type":"module"}');
        await writeFile(join(host.directory, "dist/utils/shell.js"), source);
        expect(await shellIdentity()).toBe(expected);
        expect(await shellIdentity()).toBe(expected);
        expect(await shellIdentity("/explicit/shell")).toBe("/explicit/shell");
    }
});
