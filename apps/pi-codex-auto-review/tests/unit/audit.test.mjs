import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AuditLog } from "../../dist/audit.js";
import { fixture } from "../harness/fixtures.mjs";

test("[audit] retains only the newest 1000 memory records without dropping file records", async (t) => {
    const f = await fixture(t);
    const audit = new AuditLog(join(f.control, "audit.jsonl"));
    const records = audit.records;
    const action = f.action("read", { path: "example.txt" });
    for (let i = 0; i < 1010; i++) await audit.record(action, "test", String(i));
    await audit.flush();
    expect(audit.records).toBe(records);
    expect(records).toHaveLength(1000);
    expect(records[0].outcome).toBe("10");
    expect(records.at(-1).outcome).toBe("1009");
    expect((await readFile(audit.path, "utf8")).trim().split("\n")).toHaveLength(1010);
});
