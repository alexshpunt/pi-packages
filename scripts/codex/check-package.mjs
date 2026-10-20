import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const packageDirectories = {
    "@buyong/pi-codex": "apps/pi-codex",
    "@buyong/pi-codex-auto-review": "apps/pi-codex-auto-review",
    "@buyong/pi-codex-computer-use": "apps/pi-codex-computer-use",
    "@buyong/pi-codex-fast-mode": "apps/pi-codex-fast-mode",
    "@buyong/pi-codex-image-gen": "apps/pi-codex-image-gen",
    "@buyong/redact": "packages/redact",
};
const requiredFiles = {
    "@buyong/pi-codex": ["README.md", "README.ko.md", "LICENSE"],
    "@buyong/pi-codex-auto-review": [
        "dist/index.js",
        "dist/startup.js",
        "dist/cli.js",
        "dist/tools/executor.js",
        "dist/approval-commands.js",
        "dist/policy/rules.js",
        "dist/policy/rule-engine.js",
        "dist/policy/rules-worker.js",
        "dist/policy/rules-sync.js",
        "dist/policy/starlark/evaluator.js",
        "dist/policy/starlark/parser.js",
        "dist/policy/starlark/lexer.js",
        "dist/policy/starlark/builtins.js",
        "dist/policy/starlark/values.js",
        "dist/policy/starlark/validation.js",
        "LICENSE",
        "NOTICE",
        "docs/usage.md",
    ],
    "@buyong/pi-codex-computer-use": [
        "dist/index.js",
        "dist/index.d.ts",
        "dist/connection.js",
        "dist/runtime.js",
        "dist/tools.js",
        "dist/turn.js",
        "dist/elicitation.js",
        "dist/active-call.js",
        "dist/browser-checks.js",
        "dist/commands.js",
        "dist/install.js",
        "dist/log.js",
        "dist/settings.js",
        "dist/settings-ui.js",
        "dist/platform.js",
        "README.md",
        "README.ko.md",
        "LICENSE",
        "NOTICE",
        "docs/usage.md",
        "docs/usage.ko.md",
    ],
    "@buyong/pi-codex-fast-mode": [
        "dist/index.js",
        "dist/index.d.ts",
        "dist/config.js",
        "dist/fast-controller.js",
        "dist/fast-ui.js",
        "README.md",
        "README.ko.md",
        "LICENSE",
    ],
    "@buyong/pi-codex-image-gen": [
        "dist/index.js",
        "dist/index.d.ts",
        "dist/tool.js",
        "dist/backend.js",
        "dist/auth.js",
        "dist/artifact.js",
        "dist/reference-images.js",
        "dist/settings.js",
        "dist/commands.js",
        "README.md",
        "README.ko.md",
        "LICENSE",
        "skills/imagegen/SKILL.md",
        "skills/imagegen/LICENSE.txt",
        "skills/imagegen/NOTICE",
        "skills/imagegen/references/prompting.md",
        "skills/imagegen/references/sample-prompts.md",
    ],
    "@buyong/redact": [
        "dist/index.js",
        "dist/index.d.ts",
        "dist/redactor.js",
        "dist/text.js",
        "dist/json.js",
        "dist/pii/index.js",
        "dist/pii/data/catalog.js",
        "dist/pii/data/iban-formats.js",
        "dist/pii/data/validation-data.js",
        "README.md",
        "README.ko.md",
        "LICENSE",
        "NOTICE",
    ],
};
const readManifest = (directory) =>
    JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
// pnpm resolves these protocols only when it packs a workspace package; npm cannot install them.
const workspaceProtocol = /^(workspace|catalog):/;

async function verifyPackage(packageDirectory) {
    const manifest = readManifest(packageDirectory);
    const expected = requiredFiles[manifest.name];
    const isAggregate = manifest.name === "@buyong/pi-codex";
    assert.ok(expected, `Unknown package: ${manifest.name}`);
    const packed = spawnSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        {
            cwd: packageDirectory,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            shell: process.platform === "win32",
        },
    );
    if (packed.error) throw packed.error;
    assert.equal(packed.status, 0, packed.stderr);
    const [packageInfo] = JSON.parse(packed.stdout);
    const files = new Set(packageInfo.files.map((file) => file.path));
    for (const path of expected)
        assert.ok(
            files.has(path),
            `${manifest.name}: missing package file: ${path}`,
        );
    assert.ok(
        ![...files].some(
            (path) =>
                /^(src|tests?|tmp|vendor|native)\//.test(path) ||
                (!isAggregate && /^node_modules\//.test(path)) ||
                /^dist\/(sandbox|native)\//.test(path) ||
                /\.(node|wasm|exe)$/.test(path) ||
                /(^|\/)(cua_node|@oai)(\/|$)|\.app(\/|$)/.test(path),
        ),
        "The package must not contain native binaries, development dependencies, or OpenAI runtime files",
    );
    if (isAggregate) {
        const names = [
            "@buyong/pi-codex-auto-review",
            "@buyong/pi-codex-computer-use",
            "@buyong/pi-codex-fast-mode",
            "@buyong/pi-codex-image-gen",
        ];
        assert.deepEqual(
            manifest.dependencies,
            Object.fromEntries(names.map((name) => [name, "workspace:*"])),
            "The aggregate package must bundle the workspace components",
        );
        assert.deepEqual(manifest.bundleDependencies, names);
        assert.deepEqual(
            manifest.pi.extensions,
            names.map((name) => `./node_modules/${name}/dist/index.js`),
        );
        assert.deepEqual(manifest.pi.skills, [
            "./node_modules/@buyong/pi-codex-image-gen/skills",
        ]);
        for (const name of [...names, "@buyong/redact"]) {
            assert.ok(packageInfo.bundled.includes(name));
            for (const path of requiredFiles[name])
                assert.ok(
                    files.has(`node_modules/${name}/${path}`),
                    `${manifest.name}: missing dependency file: ${name}/${path}`,
                );
            const bundled = readManifest(
                join(packageDirectory, "node_modules", name),
            );
            const workspaceVersion = readManifest(
                join(repository, packageDirectories[name]),
            ).version;
            assert.equal(
                bundled.version,
                workspaceVersion,
                `${manifest.name}: ${name} must be bundled from the workspace`,
            );
            for (const field of [
                "dependencies",
                "optionalDependencies",
                "peerDependencies",
                "devDependencies",
            ])
                for (const [dependency, range] of Object.entries(
                    bundled[field] ?? {},
                ))
                    assert.doesNotMatch(
                        range,
                        workspaceProtocol,
                        `${manifest.name}: bundled ${name} keeps ${field}.${dependency} "${range}"`,
                    );
        }
        assert.ok(
            [...files].every(
                (path) =>
                    path === "package.json" ||
                    expected.includes(path) ||
                    path.startsWith("node_modules/"),
            ),
            "The aggregate package must only contain metadata, docs, and runtime dependencies",
        );
        assert.ok(
            ![...files].some((path) =>
                /node_modules\/@earendil-works\/pi-(ai|agent-core|coding-agent|tui)\//.test(
                    path,
                ),
            ),
            "The aggregate package must not bundle Pi host packages",
        );
        assert.equal(manifest.publishConfig.access, "public");
    } else if (manifest.name === "@buyong/pi-codex-auto-review") {
        const { evaluateRules } = await import(
            pathToFileURL(join(packageDirectory, "dist/policy/rules.js")).href
        );
        const result = await evaluateRules(
            [
                {
                    name: "package.rules",
                    source: 'prefix_rule(["package-check"], decision="prompt")',
                },
            ],
            [["package-check", "--verify"]],
        );
        assert.equal(result.matches[0][0].decision, "prompt");
        assert.deepEqual(
            manifest.dependencies,
            { "@buyong/redact": "workspace:*" },
            "The package must depend on exactly the workspace @buyong/redact version",
        );
        assert.ok(
            !manifest.bundleDependencies?.length &&
                !manifest.bundledDependencies?.length,
            "The package must not bundle its runtime dependency",
        );
    } else {
        // The new package has an exact allow-list: all compiled JS/declarations/maps plus its
        // own docs. Repository briefs, runtime copies and build configuration cannot sneak in.
        const docs = new Set(
            expected.filter((path) => !path.startsWith("dist/")),
        );
        assert.ok(
            [...files].every(
                (path) =>
                    path === "package.json" ||
                    docs.has(path) ||
                    /^dist\/.+\.(js|d\.ts|js\.map)$/.test(path),
            ),
            `${manifest.name}: unexpected archive file`,
        );
        if (manifest.name !== "@buyong/redact") {
            assert.deepEqual(manifest.pi.extensions, ["./dist/index.js"]);
            if (manifest.name === "@buyong/pi-codex-image-gen")
                assert.deepEqual(manifest.pi.skills, ["./skills"]);
        }
        assert.equal(manifest.publishConfig.access, "public");
    }
    // Lifecycle hooks must not contaminate `npm pack --json` on stdout.
    console.error(
        `${manifest.name}: package verified (${files.size} files); no native binaries or bundled host dependencies`,
    );
}

const argument = process.argv[2];
const cwdManifest = join(process.cwd(), "package.json");
const cwdName = existsSync(cwdManifest)
    ? JSON.parse(readFileSync(cwdManifest, "utf8")).name
    : undefined;
const directories = argument
    ? [resolve(argument)]
    : requiredFiles[cwdName]
      ? [process.cwd()]
      : Object.values(packageDirectories)
            .map((directory) => join(repository, directory))
            .filter((directory) => existsSync(join(directory, "package.json")));
for (const directory of directories) await verifyPackage(directory);
