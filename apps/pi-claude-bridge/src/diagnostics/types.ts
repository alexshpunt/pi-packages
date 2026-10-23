export interface LoggingServices {
	readonly DEBUG: boolean;
	readonly debug: (...args: unknown[]) => void;
	readonly diagDump: (label: string, data: Record<string, unknown>) => void;
	readonly makeCliDebugOptions: (tag: string) => { debug?: boolean; debugFile?: string; stderr?: (data: string) => void };
	readonly moduleInstanceId: string;
}
