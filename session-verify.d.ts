// Type declarations for session-verify.js.

export function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
): string[];
