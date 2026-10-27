// Independent of MemoryReader: evaluate observed tool text and the answer against the fixture oracle.
const textOf = (content) =>
    typeof content === "string"
        ? content
        : (content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
export function auditRecall({
    answer,
    events,
    expected,
    obsoleteGate,
    usageDelta,
    isFresh = false,
    isEmptyControl = false,
    firstContext,
}) {
    let facts = null;
    try {
        facts = JSON.parse(
            /<facts>\s*([\s\S]*?)\s*<\/facts>/
                .exec(answer)?.[1]
                .replace(/^```(?:json)?\s*|\s*```$/g, "") ?? "null",
        );
    } catch {}
    const exactFactChecks = Object.fromEntries(
        Object.entries(expected).map(([key, value]) => [
            key,
            facts?.[key] === (isEmptyControl ? null : value),
        ]),
    );
    const factChecks = { ...exactFactChecks };
    // The question does not prescribe an enum spelling. Preserve exact results, and
    // separately recognize only these unambiguous equivalents of project-only scope.
    if (!isEmptyControl && expected.decision_scope === "this_project_only")
        factChecks.decision_scope = [
            "this_project_only",
            "project-only",
            "project_only",
            "this project only",
        ].includes(facts?.decision_scope);
    const opaqueValues = [
        expected.service,
        expected.region,
        expected.verify_command,
        expected.release_gate,
    ];
    const receipts = [];
    let actualReadCount = 0,
        actualSearchCount = 0;
    for (const event of events.filter(
        (event) => event.event === "tool_end" && !event.isError,
    )) {
        try {
            const value = JSON.parse(textOf(event.result.content));
            if (event.name === "pi_codex_memory_read") {
                receipts.push(value);
                actualReadCount++;
            }
            if (event.name === "pi_codex_memory_search") {
                actualSearchCount++;
                for (const match of value.matches)
                    receipts.push({
                        ...match,
                        start_line_number: match.content_start_line_number,
                        end_line_number:
                            match.content_start_line_number +
                            match.content.split("\n").length -
                            1,
                    });
            }
        } catch {}
    }
    const references = [];
    for (const block of answer.matchAll(
        /<citation_entries>([\s\S]*?)<\/citation_entries>/g,
    ))
        for (const match of block[1].matchAll(
            /([^\s<>|]+\.md):(\d+)-(\d+)\|note=/g,
        ))
            references.push({
                path: match[1],
                start: Number(match[2]),
                end: Number(match[3]),
            });
    const citedText = [],
        sourceIds = new Set(),
        invalid = [];
    for (const reference of references) {
        const receipt = receipts.find(
            (row) =>
                row.path === reference.path &&
                reference.start >= row.start_line_number &&
                reference.end <= row.end_line_number &&
                reference.end >= reference.start,
        );
        if (!receipt) {
            invalid.push(reference);
            continue;
        }
        citedText.push(
            receipt.content
                .split("\n")
                .slice(
                    reference.start - receipt.start_line_number,
                    reference.end - receipt.start_line_number + 1,
                )
                .join("\n"),
        );
        if (receipt.source_id) sourceIds.add(receipt.source_id);
    }
    const citedIds = new Set(
        [...answer.matchAll(/<rollout_ids>([\s\S]*?)<\/rollout_ids>/g)].flatMap(
            (match) => match[1].trim().split(/\s+/).filter(Boolean),
        ),
    );
    const hasMatchingSourceIds =
        sourceIds.size === citedIds.size &&
        [...sourceIds].every((id) => citedIds.has(id));
    const ordinaryContext = JSON.stringify(
        (firstContext?.messages ?? []).filter(
            (message) =>
                !JSON.stringify(message.content).includes("CODEX_MEMORY_V2"),
        ),
    );
    const nonMemoryContextHasOpaqueFacts = opaqueValues.some((value) =>
        ordinaryContext.includes(value),
    );
    const hasCitedOpaqueFacts = opaqueValues.every((value) =>
        citedText.join("\n").includes(value),
    );
    const hasFacts = Object.values(factChecks).every(Boolean);
    const hasValidMemoryUse =
        receipts.length > 0 &&
        references.length > 0 &&
        invalid.length === 0 &&
        hasMatchingSourceIds &&
        hasCitedOpaqueFacts &&
        usageDelta > 0;
    const passed = isEmptyControl
        ? hasFacts &&
          !opaqueValues.some((value) => answer.includes(value)) &&
          usageDelta === 0 &&
          !nonMemoryContextHasOpaqueFacts
        : hasFacts &&
          hasValidMemoryUse &&
          (!isFresh || !nonMemoryContextHasOpaqueFacts);
    return {
        criterionRevision: 3,
        passed,
        facts,
        exactFactChecks,
        factChecks,
        actualReadCount,
        actualSearchCount,
        observedSnippetCount: receipts.length,
        referenceCount: references.length,
        invalidReferences: invalid,
        hasMatchingSourceIds,
        hasCitedOpaqueFacts,
        usageDelta,
        nonMemoryContextHasOpaqueFacts,
        isFresh,
        isEmptyControl,
        answerMentionsObsoleteGate: answer.includes(obsoleteGate),
        usedPaths: [...new Set(references.map((reference) => reference.path))],
    };
}
