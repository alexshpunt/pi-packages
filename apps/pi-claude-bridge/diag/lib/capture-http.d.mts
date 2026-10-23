import type { IncomingHttpHeaders, Server } from "node:http";

export interface CapturedHttpRequest {
	n: number;
	method: string | undefined;
	path: string | undefined;
	body: Buffer;
	headers: IncomingHttpHeaders;
}
export interface CapturedHttpExchange extends CapturedHttpRequest {
	status: number;
	responseHeaders: Record<string, string>;
	text: string;
}
export function createCaptureServer(options?: {
	maxRequestBytes?: number;
	abortOnDisconnect?: boolean;
	beforeForward?: (request: CapturedHttpRequest) => void | Promise<void>;
	onRejected?: (error: unknown, request: CapturedHttpRequest) => void;
	onError?: (error: unknown, request: CapturedHttpRequest) => void;
	onExchange?: (exchange: CapturedHttpExchange) => void;
}): Server;
export function usageFromSse(text: string): { input: number; cacheRead: number; cacheWrite: number } | null;
