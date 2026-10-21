import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadContextFiles } from "../../dist/context-files.js";
import { validateSettings } from "../../dist/policy/index.js";
import { fixture } from "../harness/fixtures.mjs";

const options = (f, extra = {}) => ({
    cwd: f.workspace,
    agentDir: f.agentDir,
    profile: f.profile,
    settings: validateSettings({}),
    isProjectTrusted: true,
    ...extra,
});
test("[context-files] nearest project root, override precedence and configured fallback follow Codex discovery", async (t) => {
    const f = await fixture(t),
        child = join(f.workspace, "child");
    await mkdir(join(f.workspace, ".git"));
    await mkdir(child);
    await writeFile(join(f.root, "AGENTS.md"), "outside-project");
    await writeFile(join(f.agentDir, "AGENTS.md"), "global-base");
    await writeFile(join(f.agentDir, "AGENTS.override.md"), "global-override");
    await writeFile(join(f.workspace, "AGENTS.md"), "project-base");
    await writeFile(
        join(f.workspace, "AGENTS.override.md"),
        "project-override",
    );
    await writeFile(join(child, "TEAM.md"), "child-fallback");
    const settings = validateSettings({
        projectDocFallbackFilenames: ["../AGENTS.md", "TEAM.md", "TEAM.md"],
    });
    const files = loadContextFiles(options(f, { cwd: child, settings }));
    expect(files.map((file) => file.content)).toStrictEqual([
        "global-override",
        "project-override",
        "child-fallback",
    ]);
    await writeFile(join(child, "AGENTS.override.md"), " \n");
    expect(
        loadContextFiles(options(f, { cwd: child, settings })).map(
            (file) => file.content,
        ),
    ).toStrictEqual(["global-override", "project-override"]);
    await mkdir(join(child, ".git"));
    expect(
        loadContextFiles(options(f, { cwd: child, settings })).map(
            (file) => file.content,
        ),
    ).toStrictEqual(["global-override"]);
});
test("[context-files] absent markers, empty markers, untrusted projects and UTF-8 byte limits stay bounded", async (t) => {
    const f = await fixture(t),
        child = join(f.workspace, "child");
    await mkdir(child);
    await writeFile(join(f.agentDir, "AGENTS.md"), "global");
    await writeFile(join(f.workspace, "AGENTS.md"), "parent");
    await writeFile(join(child, "AGENTS.md"), "한글after");
    const settings = validateSettings({ projectDocMaxBytes: 4 });
    expect(
        loadContextFiles(options(f, { cwd: child, settings })).map(
            (file) => file.content,
        ),
    ).toStrictEqual(["global", "한�"]);
    await mkdir(join(f.workspace, ".git"));
    expect(
        loadContextFiles(
            options(f, {
                cwd: child,
                settings: validateSettings({ projectRootMarkers: [] }),
            }),
        ).map((file) => file.content),
    ).toStrictEqual(["global", "한글after"]);
    expect(
        loadContextFiles(
            options(f, { cwd: child, isProjectTrusted: false }),
        ).map((file) => file.content),
    ).toStrictEqual(["global"]);
    expect(
        loadContextFiles(
            options(f, {
                settings: validateSettings({ projectDocMaxBytes: 0 }),
            }),
        ).map((file) => file.content),
    ).toStrictEqual(["global"]);
});
test("[context-files] permitted symlinks work while protected targets and hard-link aliases cannot enter prompts", async (t) => {
    const f = await fixture(t),
        docs = join(f.workspace, "docs");
    await mkdir(docs);
    const allowed = join(f.workspace, "owned.md");
    await writeFile(allowed, "owned instruction");
    await symlink(allowed, join(docs, "AGENTS.md"));
    expect(loadContextFiles(options(f, { cwd: docs }))[0].content).toBe(
        "owned instruction",
    );
    await symlink(
        join(f.control, "protected.txt"),
        join(f.workspace, "AGENTS.md"),
    );
    expect(() => loadContextFiles(options(f))).toThrow(
        /protected read boundary/,
    );
    const hard = join(f.workspace, "hard");
    await mkdir(hard);
    await link(join(f.control, "protected.txt"), join(hard, "AGENTS.md"));
    expect(() => loadContextFiles(options(f, { cwd: hard }))).toThrow(
        /hard-link aliases/,
    );
});
