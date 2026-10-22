import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Custom session entry that records `/redact`'s choice for one session; the model never sees it. */
export const SESSION_CHOICE_ENTRY = "pi-redact-session";

export interface SessionChoice {
  readonly version: 1;
  readonly enabled: boolean;
}

export function sessionChoiceData(enabled: boolean): SessionChoice {
  return { version: 1, enabled };
}

/**
 * The latest choice on the current branch, or `undefined` when the session follows the
 * global default. Entries of other branches are ignored, so `/tree` restores each branch's own choice.
 */
export function restoreSessionChoice(branch: readonly SessionEntry[]): boolean | undefined {
  let enabled: boolean | undefined;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== SESSION_CHOICE_ENTRY) continue;
    const data = entry.data as Partial<SessionChoice> | undefined;
    if (data?.version === 1 && typeof data.enabled === "boolean") enabled = data.enabled;
  }
  return enabled;
}
