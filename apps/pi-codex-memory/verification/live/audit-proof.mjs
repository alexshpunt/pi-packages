// Independent fact/provenance audit: intentionally does not import production memory code.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(process.argv[2]);
const load = async file => JSON.parse(await readFile(join(root, file), "utf8"));
const proof = await load("proof.json"), plan = await load("case.json");
const events = (await readFile(join(root, "seed-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
const values = [plan.marker, plan.region], checks = {};
const hasFacts = text => values.every(value => text.includes(value));
const hash = value => createHash("sha256").update(value).digest("hex");
const check = (key, value) => { checks[key] = !!value; assert.ok(value, key); };
const unwrap = text => text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
const report = { status: "fail", checks };
try {
    check("proof_completed", proof.status === "pass");
    const record = proof.generated.records.find(row => hasFacts(row.body));
    check("stored_both_facts", record);
    const source = (await readFile(record.source.file, "utf8")).trim().split("\n").map(JSON.parse);
    check("facts_in_original_user_message", source.some(row => row.type === "message" && row.message.role === "user" && hasFacts(JSON.stringify(row.message.content))));
    check("source_identity", source[0].id === record.source.id);
    const request = events.find(row => row.event === "model_request" && row.kind === "extraction" && JSON.parse(row.context.messages[0].content[0].text).source_thread_id === record.source.id);
    check("actual_extraction_input", request && hasFacts(request.context.messages[0].content[0].text));
    const response = events.find(row => row.event === "model_result" && row.requestId === request.requestId);
    check("complete_model_response", response?.stopReason === "stop");
    check("response_equals_stored_body", JSON.parse(unwrap(response.text)).rollout_summary.trim() === record.body);
    check("consolidation_points_to_record", proof.generated.summary.includes(record.path));
    report.summaryContainsFacts = hasFacts(proof.generated.summary);
    const seedId = proof.seed.events.find(row => row.event === "settled").sessionId;
    const recallId = proof.positive.events.find(row => row.event === "settled").sessionId;
    check("different_fresh_session", seedId !== recallId && seedId === record.source.id);
    const firstRequest = proof.positive.events.find(row => row.event === "model_request" && row.kind === "foreground");
    const userMessages = firstRequest.context.messages.filter(row => row.role === "user" && !JSON.stringify(row.content).includes("CODEX_MEMORY_V2"));
    check("question_does_not_supply_answer", userMessages.length > 0 && !values.some(value => JSON.stringify(userMessages).includes(value)));
    const receipt = proof.positive.events.filter(row => row.event === "tool_end" && row.name === "pi_codex_memory_read" && !row.isError)
        .map(row => JSON.parse(row.result.content.filter(part => part.type === "text").map(part => part.text).join("\n")))
        .find(row => row.path === record.path && hasFacts(row.content));
    check("actual_tool_receipt", receipt?.source_id === seedId);
    const db = new DatabaseSync(join(root, "agent/pi-codex-memory/state.sqlite"), { readOnly: true });
    const stored = db.prepare("SELECT scope,value FROM records WHERE path = ?").get(record.path); db.close();
    const document = await readFile(join(root, "agent/pi-codex-memory/scopes", stored.scope, record.path), "utf8");
    const lines = document.split("\n");
    check("receipt_equals_published_lines", lines.slice(receipt.start_line_number - 1, receipt.end_line_number).join("\n") === receipt.content);
    const citations = [...proof.positive.answer.matchAll(/([^\s<>|]+\.md):(\d+)-(\d+)\|note=/g)];
    const citation = citations.find(([, path, start, end]) => path === record.path && Number(start) >= receipt.start_line_number && Number(end) <= receipt.end_line_number && Number(start) <= Number(end));
    check("cited_actual_read_range", citation);
    check("cited_lines_contain_both_facts", hasFacts(lines.slice(Number(citation[2]) - 1, Number(citation[3])).join("\n")));
    check("cited_source_id", /<rollout_ids>([\s\S]*?)<\/rollout_ids>/.exec(proof.positive.answer)?.[1].trim() === seedId);
    check("answer_contains_both_values", hasFacts(proof.positive.answer));
    check("validated_usage_recorded", JSON.parse(stored.value).usageCount > 0);
    if (proof.control.status === "not_repeated") report.control = proof.control;
    else {
        check("control_input_has_no_answer", proof.control.events.filter(row => row.event === "model_request").every(row => !values.some(value => JSON.stringify(row.context).includes(value))));
        check("control_answer_is_unknown", /모르|없|알 수/.test(proof.control.answer) && !/\b(?:violet|amber)-\d+\b|zone-river-\d+/.test(proof.control.answer));
    }
    report.chain = { seedId, recallId, path: record.path, requestId: request.requestId, inputSHA256: hash(request.context.messages[0].content[0].text), responseSHA256: hash(response.text), storedBodySHA256: hash(record.body), documentSHA256: hash(document), answerSHA256: hash(proof.positive.answer) };
    report.status = "pass";
} catch (error) { report.error = String(error); process.exitCode = 1; }
await writeFile(join(root, "independent-audit.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
