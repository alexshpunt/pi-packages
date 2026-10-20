/** Guard usage-status refreshes against stale generations and duplicate triggers. */
export function createUsageStatusRefreshGuard() {
  let generation = 0;
  let inFlightGeneration: number | undefined;
  let activeController: AbortController | undefined;

  return {
    invalidate() {
      generation += 1;
      activeController?.abort();
      activeController = undefined;
    },
    async run(
      isCurrent: () => boolean,
      refresh: (stillCurrent: () => boolean, signal: AbortSignal) => Promise<string | undefined>,
      setStatus: (text: string | undefined) => void,
      externalSignal?: AbortSignal,
    ): Promise<void> {
      if (inFlightGeneration === generation || !isCurrent() || externalSignal?.aborted) return;
      const requestGeneration = generation;
      const controller = new AbortController();
      activeController = controller;
      inFlightGeneration = requestGeneration;
      const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
      const stillCurrent = () => !signal.aborted && generation === requestGeneration && isCurrent();
      try {
        const text = await refresh(stillCurrent, signal);
        if (stillCurrent()) setStatus(text);
      } catch {
        if (stillCurrent()) setStatus(undefined);
      } finally {
        controller.abort();
        if (activeController === controller) activeController = undefined;
        if (inFlightGeneration === requestGeneration) inFlightGeneration = undefined;
      }
    },
  };
}

/** Resolve an on/off toggle argument; an empty argument flips the current state. */
export function resolveToggleArgument(
  arg: string,
  current: boolean,
  usage: string,
): { enabled: boolean; error?: string } {
  const a = arg.trim().toLowerCase();
  if (a === "on" || a === "enable") return { enabled: true };
  if (a === "off" || a === "disable") return { enabled: false };
  if (a === "") return { enabled: !current };
  return { enabled: current, error: `Unknown argument "${arg.trim()}". Usage: ${usage}` };
}

/** Resolve the new enabled state for `/ollama status` from its argument. */
export function resolveUsageStatusToggle(arg: string, current: boolean): { enabled: boolean; error?: string } {
  return resolveToggleArgument(arg, current, "/ollama status [on|off]");
}
