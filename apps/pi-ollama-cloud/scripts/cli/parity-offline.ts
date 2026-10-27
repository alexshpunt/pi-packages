import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyPackageConsumer } from "../lib/verification/consumer.ts";

const { values } = parseArgs({
  options: {
    before: { type: "string" },
    after: { type: "string" },
    report: { type: "string" },
  },
});
if (!values.before || !values.after || !values.report) {
  throw new Error("Requires --before <installed-package> --after <installed-package> --report <new-file>");
}
const before = resolve(values.before);
const after = resolve(values.after);
const reportPath = resolve(values.report);
const report = {
  schemaVersion: 1,
  status: "running",
  before,
  after,
  profiles: [] as { profile: string; pass: boolean; contract: Record<string, unknown>; digest: string }[],
};
writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
const directory = mkdtempSync(join(tmpdir(), "ollama-contract-parity-"));
try {
  for (const profile of ["enabled", "soft-disabled", "hard-disabled"] as const) {
    const original = verifyPackageConsumer(before, join(directory, `before-${profile}`), profile);
    const candidate = verifyPackageConsumer(after, join(directory, `after-${profile}`), profile);
    assert.deepEqual(candidate, original, `Before/after contract mismatch: ${profile}`);
    report.profiles.push({
      profile,
      pass: true,
      contract: candidate,
      digest: createHash("sha256").update(JSON.stringify(candidate)).digest("hex"),
    });
  }
  report.status = "pass";
} catch (error) {
  report.status = "fail";
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : "Offline parity failed");
} finally {
  rmSync(directory, { recursive: true, force: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      status: report.status,
      profiles: report.profiles.map(({ profile, pass }) => ({ profile, pass })),
    }),
  );
}
