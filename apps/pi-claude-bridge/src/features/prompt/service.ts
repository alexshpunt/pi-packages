import { Context as ServiceContext, Effect, Layer } from "effect";
import type { ProviderPromptsDependencies, ProviderPromptsServices } from "./types.js";
import { Diagnostics } from "../../diagnostics/service.js";
import { messageContentToText } from "../session/convert.js";
import { sharedPromptCaptures } from "./capture.js";
import type { Base64ImageSource } from "@anthropic-ai/sdk/resources";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context } from "@earendil-works/pi-ai";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { TextContent } from "@earendil-works/pi-ai";
import type { UserMessage } from "@earendil-works/pi-ai";

export function createProviderPrompts({ diagnostics }: ProviderPromptsDependencies): ProviderPromptsServices {
	/** Index of the first message of the current user turn — the trailing run of
	 *  user messages that has not been written into the Claude Code session yet.
	 *  Equals messages.length when the last message is not a user message.
	 *
	 *  Single source of truth for the history/prompt split: everything before this
	 *  index is replayed as session history, everything from it onward becomes the
	 *  prompt. Deriving both halves from one index is what keeps a message from
	 *  landing in both — an extension appending a display-only user message after
	 *  the real one (see issue #34) makes the turn longer than one message. */
	function turnStart(messages: Context["messages"]): number {
		let i = messages.length;
		while (i > 0 && messages[i - 1].role === "user") i--;
		return i;
	}

	/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
	function extractUserPrompt(messages: Context["messages"]): string | null {
		const turn = messages.slice(turnStart(messages)) as UserMessage[];
		if (turn.length === 0) return null;
		// Drop empties before joining so an all-empty turn still yields "" and trips
		// the caller's empty-prompt guard rather than sending bare newlines.
		return turn
			.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
			.filter((text) => text)
			.join("\n");
	}

	/** Extract the current user turn as ContentBlockParam[] (preserving images).
	 *  Returns null if no images — caller should fall back to string prompt. */
	function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
		const turn = messages.slice(turnStart(messages)) as UserMessage[];
		if (turn.length === 0) return null;

		let hasImage = false;
		const blocks: ContentBlockParam[] = [];
		for (const message of turn) {
			const content: (TextContent | ImageContent)[] = typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content;
			// Off-type content violates UserMessage's contract, so fail rather than
			// degrade — but name the shape, since the cause is almost always another
			// extension appending a malformed message, not this file.
			if (!Array.isArray(content)) {
				throw new Error(
					`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
				);
			}
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "image") {
					// Guard before logging: data-less image blocks do occur, and reading
					// .length off the missing field in the debug template would throw
					// before this check ever runs (template args evaluate unconditionally).
					if (!block.data || !block.mimeType) {
						diagnostics.debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
						continue;
					}
					diagnostics.debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
					hasImage = true;
					blocks.push({
						type: "image",
						source: {
							type: "base64",
							media_type: block.mimeType as Base64ImageSource["media_type"],
							data: block.data,
						},
					});
				}
			}
		}
		diagnostics.debug(`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`);
		return hasImage ? blocks : null;
	}

	function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
		if (messages.length !== 1 || messages[0].role !== "user") {
			throw new Error(
				`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
				`(${messages.map((m) => m.role).join(",")})`,
			);
		}
		const promptText = extractUserPrompt(messages);
		if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
		return promptText;
	}

	// Captures of what pi assembled per agent; see src/features/prompt/capture.ts for why this
	// is keyed rather than held in a single slot. One process-wide instance, shared
	// across every extension module instance: isolated subagents re-evaluate this
	// module, and the pinned stream they all route through resolves against it.
	const promptCaptures = sharedPromptCaptures((diagnostic) => {
		const first = diagnostic.matches[0];
		diagnostics.debug(
			`prompt-capture: no match for ${diagnostic.systemPrompt.length}-char system prompt. `
			+ (first
				? `closest known (${first.key.length}-char) shares its first ${first.firstDivergent} chars and diverges at offset ${first.firstDivergent}: `
				  + JSON.stringify(diagnostic.systemPrompt.slice(first.firstDivergent - 40, first.firstDivergent + 60))
				: "no known captures to compare against."
			) + ` known keys=${diagnostic.matches.length}`,
		);
	});

	/** The trailing user turn as content blocks, or null if there isn't one.
	 *  Blocks rather than text so image steers keep their images. */
	function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
		const blocks = extractUserPromptBlocks(messages);
		if (blocks) return blocks;
		const text = extractUserPrompt(messages);
		return text ? [{ type: "text", text }] : null;
	}

	return {
		extractIsolatedSummaryPrompt,
		extractUserPrompt,
		extractUserPromptBlocks,
		promptCaptures,
		steerBlocks,
		turnStart,
	};
}

export class Prompts extends ServiceContext.Service<Prompts, ProviderPromptsServices>()("claude-bridge/Prompts") {}
export const PromptsLive = Layer.effect(Prompts, Effect.gen(function* () {
	const diagnostics = yield* Diagnostics;
	return createProviderPrompts({ diagnostics });
}));
