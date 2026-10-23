// Carrying Claude Code's own attachments across a session rebuild.
//
// CC expands an `@file` mention itself — pi passes `@` through untouched — and
// writes the expansion as a `type: "attachment"` record in its session file. pi
// never sees it, so rebuilding a session from pi's history drops the file while
// keeping the prompt text that referred to it: the model silently loses
// something it was reasoning about, with nothing logged.
//
// Extracted from index.ts so tests can import it without activating the extension.

import type { JsonlRecord, ImportAttachment } from "cc-session-io";
import type { AttachmentAnchor, CarriedAttachment } from "./types.js";
import { messageContentToText } from "./convert.js";

// File expansions and session context must stay where CC first put them. If
// context is dropped, CC reattaches it to the newest prompt instead and changes
// the already-cached prefix. Per-turn reminders also hang from tool results.
// Edited-file snapshots and regenerated listings remain outside this policy.
const CARRIED_TYPES = new Set([
	"file", "environment", "model", "output_style_instructions", "total_tokens_reminder",
	"output_style", "session_context", "date", "credential_org", "instructions",
]);

type Rec = Record<string, unknown>;

/** A user record holding a prompt, as opposed to one holding tool results. */
function userPromptText(record: Rec): string | undefined {
	if (record.type !== "user") return undefined;
	const content = (record.message as Rec | undefined)?.content;
	if (Array.isArray(content) && content.some((b) => (b as Rec)?.type === "tool_result")) return undefined;
	const text = messageContentToText(content as never);
	return text ? text : undefined;
}

/**
 * Content-bearing attachments in a session, each tagged with where its parent
 * sits among the text-bearing user records.
 *
 * The ordinal is the mapping key rather than the record index: a rebuild does not
 * reproduce the old record list one-for-one — `importMessages` splits a message
 * carrying tool results into two records, and CC appends records of its own — but
 * the sequence of user prompts is the same conversation either way.
 *
 * Attachments also chain to one another. Inherit the original prompt or tool
 * result anchor through those links, including through kinds not carried here.
 */
export function collectCarriedAttachments(records: readonly JsonlRecord[]): CarriedAttachment[] {
	const anchorOf = new Map<string, AttachmentAnchor>();
	let ordinal = 0;
	const carried: CarriedAttachment[] = [];

	for (const raw of records) {
		const record = raw as Rec;
		if (typeof record.uuid !== "string") continue;
		const prompt = userPromptText(record);
		if (prompt !== undefined) {
			anchorOf.set(record.uuid, { userOrdinal: ordinal++, parentText: prompt });
			continue;
		}
		if (record.type === "user") {
			const content = (record.message as Rec | undefined)?.content;
			const result = Array.isArray(content) ? content.find((block: Rec) => block?.type === "tool_result") as Rec | undefined : undefined;
			if (typeof result?.tool_use_id === "string") anchorOf.set(record.uuid, { toolUseId: result.tool_use_id });
			continue;
		}
		if (record.type !== "attachment") continue;
		const parent = record.parentUuid;
		// Follow every attachment in the chain, even regenerated kinds we do not
		// carry: a later retained attachment can inherit its anchor through them.
		if (typeof parent !== "string" || !anchorOf.has(parent)) continue;
		const inherited = anchorOf.get(parent)!;
		anchorOf.set(record.uuid, inherited);

		const attachment = record.attachment as { type: string; [key: string]: unknown } | undefined;
		if (!attachment || !CARRIED_TYPES.has(attachment.type)) continue;
		carried.push({ attachment, ...inherited });
	}
	return carried;
}

/**
 * Resolve each carried attachment to a position in the array about to be
 * imported — the messages *after* conversion and repair, since that is the index
 * space `importMessages` reads. Repair is idempotent, so an already-repaired array
 * passes through its second run unchanged and the indices stay valid.
 *
 * Deliberately conservative: attaching a file to the wrong turn tells the model it
 * saw something at a point it did not, which is worse than the loss this exists to
 * prevent. So the ordinal has to land on a prompt whose text still matches; any
 * disagreement is reported and dropped rather than approximated.
 */
export function placeCarriedAttachments(
	carried: readonly CarriedAttachment[],
	messages: readonly { role: string; content: unknown }[],
): { attachments: ImportAttachment[]; skipped: string[] } {
	const prompts: { index: number; text: string }[] = [];
	messages.forEach((msg, index) => {
		if (msg.role !== "user") return;
		if (Array.isArray(msg.content) && msg.content.some((b) => (b as Rec)?.type === "tool_result")) return;
		const text = messageContentToText(msg.content as never);
		if (text) prompts.push({ index, text });
	});

	const toolResultIndices = new Map<string, number>();
	messages.forEach((message, index) => {
		if (message.role !== "user" || !Array.isArray(message.content)) return;
		for (const block of message.content as Rec[]) {
			if (block?.type === "tool_result" && typeof block.tool_use_id === "string") toolResultIndices.set(block.tool_use_id, index);
		}
	});
	const attachments: ImportAttachment[] = [];
	const skipped: string[] = [];
	for (const item of carried) {
		const name = String(item.attachment.filename ?? item.attachment.type);
		if ("toolUseId" in item) {
			const index = toolResultIndices.get(item.toolUseId);
			if (index === undefined) skipped.push(`${name}: result of ${item.toolUseId} is no longer in history`);
			else attachments.push({ afterIndex: index, attachment: item.attachment });
			continue;
		}
		const candidate = prompts[item.userOrdinal];
		if (!candidate) {
			skipped.push(`${name}: prompt #${item.userOrdinal} is no longer in history`);
			continue;
		}
		if (candidate.text !== item.parentText) {
			skipped.push(`${name}: prompt #${item.userOrdinal} changed`);
			continue;
		}
		attachments.push({ afterIndex: candidate.index, attachment: item.attachment });
	}
	return { attachments, skipped };
}
