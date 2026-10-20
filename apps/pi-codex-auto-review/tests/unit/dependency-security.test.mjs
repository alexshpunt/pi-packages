import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

test("[dependency-security] the extension has no sandbox runtime or bundled production dependencies", async () => {
    const pkg = JSON.parse(
        await readFile(
            new URL(
                "../../package.json",
                import.meta.url,
            ),
            "utf8",
        ),
    );
    const lock = await readFile(
        new URL("../../../../pnpm-lock.yaml", import.meta.url),
        "utf8",
    );
    assert.equal(
        pkg.dependencies?.["@anthropic-ai/sandbox-runtime"],
        undefined,
    );
    assert.ok(!pkg.bundleDependencies?.length);
    // pnpm-lock.yaml keys every resolved package as `name@version`.
    assert.doesNotMatch(lock, /(^|[\s'"/])(@anthropic-ai\/sandbox-runtime|node-forge)@/m);
});

test("[dependency-security] Pi brace expansion handles bounded adversarial input without a crash or event-loop stall", async () => {
    const piRequire = createRequire(
        import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const minimatchRequire = createRequire(piRequire.resolve("minimatch"));
    const moduleURL = pathToFileURL(
        minimatchRequire.resolve("brace-expansion"),
    ).href;
    const program = `
    const module = await import(${JSON.stringify(moduleURL)});
    const expand = module.expand ?? module.default;
    const control = expand('a{b,c}');
    if (JSON.stringify(control) !== '["ab","ac"]') throw new Error('positive brace control failed');
    for (const input of ['{a}' + '}'.repeat(65536) + ',z}', '{' + 'x,'.repeat(12000) + 'z}']) {
      const output = expand(input);
      if (!Array.isArray(output) || output.length === 0) throw new Error('invalid bounded expansion');
    }
    console.log('bounded brace inputs completed');
  `;
    const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--max-old-space-size=96", "--input-type=module", "-e", program],
        { timeout: 5000, maxBuffer: 16384, env: { PATH: process.env.PATH } },
    );
    assert.equal(stdout.trim(), "bounded brace inputs completed");
});
