import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Verification-only, cross-process cap. Counts host model requests, not provider-internal retries. */
export function attachBudget(runtime, { maximum = 80 } = {}) {
    if (!Number.isSafeInteger(maximum) || maximum < 1)
        throw new Error("Invalid verification request cap.");
    const path = process.env.PI_MEMORY_BUDGET;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    database.exec(
        "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS budget(id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL, maximum INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY, provider TEXT, model TEXT, started_ms INTEGER);",
    );
    // Existing ledgers retain their original cap; never reset prior accounting.
    database.prepare("INSERT OR IGNORE INTO budget VALUES(1,0,?)").run(maximum);
    const original = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = (model, context, options) => {
        database.exec("BEGIN IMMEDIATE");
        let row;
        try {
            row = database
                .prepare(
                    "UPDATE budget SET used=used+1 WHERE id=1 AND used<maximum RETURNING used",
                )
                .get();
            if (!row)
                throw new Error("LIVE_VERIFICATION_CALL_BUDGET_EXHAUSTED");
            database
                .prepare("INSERT INTO calls VALUES(?,?,?,?)")
                .run(row.used, model.provider, model.id, Date.now());
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        return original(model, context, options);
    };
    process.once("exit", () => database.close());
}
