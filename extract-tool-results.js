// Tool-result extraction: walks the context tail to collect this turn's
// tool results. Pi appends results to context and calls the provider again;
// this scrapes them back out. Walks past user messages (steer/followUp) that
// pi may inject between toolResults. Stops at the nearest assistant message
// (turn boundary).
// Extracted from index.ts so tests can import without activating the extension.

export function toolResultToMcpContent(content) {
	if (typeof content === "string") return [{ type: "text", text: content || "" }];
	if (!Array.isArray(content)) return [{ type: "text", text: "" }];
	const blocks = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return blocks.length ? blocks : [{ type: "text", text: "" }];
}

// Returns { results, stopIdx } so callers can log the walk boundary.
export function extractAllToolResults(messages) {
	const results = [];
	let stopIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			results.unshift({ content: toolResultToMcpContent(msg.content), isError: msg.isError, toolCallId: msg.toolCallId });
		} else if (msg.role === "assistant") { stopIdx = i; break; }
		// user messages: skip (steer/followUp injected mid-tool-execution)
	}
	return { results, stopIdx };
}
