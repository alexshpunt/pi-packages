// Type declarations for skills.js.

export const MCP_SERVER_NAME: string;
export const MCP_TOOL_PREFIX: string;

export function extractSkillsBlock(systemPrompt?: string): string | undefined;
export function rewriteSkillsBlock(skillsBlock: string): string;
