import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const readManifest = (directory) =>
    JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
const manifest = readManifest(packageDirectory);
assert.deepEqual(
    manifest.bundleDependencies,
    Object.keys(manifest.dependencies),
);
const isWindows = process.platform === "win32";

function resolveDependency(name, directory) {
    for (let parent = directory; ; parent = dirname(parent)) {
        const candidate = join(parent, "node_modules", name);
        if (existsSync(join(candidate, "package.json")))
            return realpathSync(candidate);
        if (parent === dirname(parent))
            throw new Error(`실행 의존성을 찾을 수 없습니다: ${name}`);
    }
}

// pnpm links workspace packages; `workspace:*` accepts the linked version as it is.
function satisfies(version, range) {
    const workspaceRange = range.startsWith("workspace:")
        ? range.slice("workspace:".length)
        : range;
    return (
        ["*", "^", "~"].includes(workspaceRange) ||
        semver.satisfies(version, workspaceRange)
    );
}

const run = (command, args, cwd) =>
    execFileSync(isWindows ? `${command}.cmd` : command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        shell: isWindows,
        stdio: ["ignore", "pipe", "pipe"],
    });

// A workspace package is staged from its own `pnpm pack` archive, so the bundle holds the
// published manifest with `workspace:` and `catalog:` ranges resolved, as npm can install it.
function stageWorkspacePackage(directory, target, scratch) {
    const destination = mkdtempSync(join(scratch, "pack-"));
    run("pnpm", ["pack", "--pack-destination", destination], directory);
    const [archive] = readdirSync(destination).filter((file) =>
        file.endsWith(".tgz"),
    );
    assert.ok(archive, `압축 패키지를 만들지 못했습니다: ${directory}`);
    mkdirSync(target, { recursive: true });
    execFileSync(
        "tar",
        ["-xzf", join(destination, archive), "-C", target, "--strip-components=1"],
        { stdio: ["ignore", "pipe", "pipe"] },
    );
}

// A registry package already has its published manifest; copy npm's file set.
function stageRegistryPackage(directory, target) {
    const [packed] = JSON.parse(
        run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], directory),
    );
    for (const { path } of packed.files) {
        mkdirSync(dirname(join(target, path)), { recursive: true });
        copyFileSync(join(directory, path), join(target, path));
    }
}

// Copy each runtime dependency into a physical tree. Packing pnpm's symlinked
// node_modules directly would point outside the package.
const staging = mkdtempSync(join(packageDirectory, ".package-"));
const scratch = mkdtempSync(join(packageDirectory, ".package-archives-"));
const dependencies = new Map();
function stageDependency(name, range, parentDirectory) {
    const directory = resolveDependency(name, parentDirectory);
    const dependency = readManifest(directory);
    assert.equal(dependency.name, name);
    assert.ok(
        satisfies(dependency.version, range),
        `${name}@${dependency.version}은 ${range}에 맞지 않습니다. pnpm install을 실행하세요.`,
    );
    if (dependencies.has(name)) {
        assert.equal(
            dependencies.get(name),
            dependency.version,
            `통합 패키지에 서로 다른 ${name} 버전을 포함할 수 없습니다.`,
        );
        return;
    }
    dependencies.set(name, dependency.version);
    const target = join(staging, name);
    if (directory.split(sep).includes("node_modules"))
        stageRegistryPackage(directory, target);
    else stageWorkspacePackage(directory, target, scratch);
    for (const [childName, childRange] of Object.entries(
        dependency.dependencies ?? {},
    ))
        stageDependency(childName, childRange, directory);
}

try {
    for (const [name, range] of Object.entries(manifest.dependencies))
        stageDependency(name, range, packageDirectory);
    rmSync(join(packageDirectory, "node_modules"), {
        recursive: true,
        force: true,
    });
    renameSync(staging, join(packageDirectory, "node_modules"));
    console.error(`통합 패키지 준비 완료: 실행 의존성 ${dependencies.size}개`);
} finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
}
