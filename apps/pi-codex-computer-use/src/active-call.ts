import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The bridged tool call currently executing; confirmation requests arrive while it is pending. */
export interface ActiveCall {
    toolName: string;
    callId: string;
    ctx: ExtensionContext;
    signal: AbortSignal | undefined;
    /** Plain sentences appended to the tool result, for example why a request was declined. */
    notes: string[];
}

/** Bridged tools run sequentially, so at most one call is active at a time. */
export class ActiveCallTracker {
    private active: ActiveCall | undefined;

    get current(): ActiveCall | undefined {
        return this.active;
    }

    begin(call: Omit<ActiveCall, "notes">): ActiveCall {
        const active: ActiveCall = { ...call, notes: [] };
        this.active = active;
        return active;
    }

    end(call: ActiveCall): void {
        if (this.active === call) this.active = undefined;
    }
}
