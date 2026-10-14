// Claude Code's auto-compact threshold math (w5 / O4 / L$e / D$e in the 2.1.296 bundle).
// R = min(maxOutputTokens, 20000), E = window - R, compact at E - 13000 (or a % of E, capped there),
// warn 20000 below that, block at (contextWindow - R) - 3000, precompute at min(E - 20% of E, threshold).

export const MAX_OUTPUT_RESERVE_TOKENS = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const WARNING_BUFFER_TOKENS = 20_000;
export const BLOCKING_BUFFER_TOKENS = 3_000;
export const PRECOMPUTE_BUFFER_FRACTION = 0.2;
/** Below this the warning level would go negative and compaction would refill almost immediately. */
export const MIN_THRESHOLD_TOKENS = 20_000;

export interface ModelLimits {
  contextWindow: number;
  maxTokens: number;
}

/** Per-model setting as stored in the config file. `threshold` is tokens or "N%" of the effective window. */
export interface ModelCompactSetting {
  window?: number;
  threshold?: number | string;
}

export type ThresholdSource = "default" | "tokens" | "percent";

export interface CompactThresholds {
  contextWindow: number;
  /** Auto-compact window W (Claude Code's autoCompactWindow), never above the model's context window. */
  window: number;
  outputReserve: number;
  effectiveWindow: number;
  threshold: number;
  warning: number;
  blocking: number;
  precompute: number;
  source: ThresholdSource;
}

export type ThresholdResult = { ok: true; value: CompactThresholds } | { ok: false; error: string };

export type ParsedThreshold = { kind: "tokens"; value: number } | { kind: "percent"; value: number };

export function outputReserveTokens(maxTokens: number): number {
  return maxTokens > 0 ? Math.min(maxTokens, MAX_OUTPUT_RESERVE_TOKENS) : MAX_OUTPUT_RESERVE_TOKENS;
}

/** Parses "367k", "1.5m", "367000", or "80%". */
export function parseTokenAmount(input: string): ParsedThreshold | undefined {
  const text = input.trim().toLowerCase().replaceAll(",", "").replaceAll("_", "");
  const percent = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (percent) return { kind: "percent", value: Number(percent[1]) };
  const amount = text.match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
  if (!amount) return undefined;
  const multiplier = amount[2] === "m" ? 1_000_000 : amount[2] === "k" ? 1_000 : 1;
  return { kind: "tokens", value: Math.round(Number(amount[1]) * multiplier) };
}

export function parseThresholdSetting(value: number | string): ParsedThreshold | undefined {
  if (typeof value === "number") return { kind: "tokens", value };
  return parseTokenAmount(value);
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000 === 0) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(2).replace(/0+$/, "")}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export function computeThresholds(limits: ModelLimits, setting: ModelCompactSetting | undefined): ThresholdResult {
  const { contextWindow } = limits;
  if (!(contextWindow > 0)) return { ok: false, error: "the model does not declare a context window" };
  const outputReserve = outputReserveTokens(limits.maxTokens);

  const window = setting?.window ?? contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0)
    return { ok: false, error: `window ${window} is not a positive integer` };
  if (window > contextWindow) {
    return {
      ok: false,
      error: `window ${formatTokens(window)} exceeds the model's context window ${formatTokens(contextWindow)}`,
    };
  }

  const effectiveWindow = window - outputReserve;
  const defaultThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
  if (defaultThreshold < MIN_THRESHOLD_TOKENS) {
    return {
      ok: false,
      error: `window ${formatTokens(window)} leaves no room: threshold ${defaultThreshold} would be below ${formatTokens(MIN_THRESHOLD_TOKENS)}`,
    };
  }

  let threshold = defaultThreshold;
  let source: ThresholdSource = "default";
  if (setting?.threshold !== undefined) {
    const parsed = parseThresholdSetting(setting.threshold);
    if (!parsed) return { ok: false, error: `threshold "${setting.threshold}" is not tokens (e.g. 367k) or a percent` };
    if (parsed.kind === "percent") {
      if (!(parsed.value > 0 && parsed.value <= 100)) {
        return { ok: false, error: `percent ${parsed.value} must be in (0, 100]` };
      }
      threshold = Math.min(Math.floor((effectiveWindow * parsed.value) / 100), defaultThreshold);
      source = "percent";
    } else {
      if (!Number.isSafeInteger(parsed.value))
        return { ok: false, error: `threshold ${parsed.value} is not an integer` };
      if (parsed.value > defaultThreshold) {
        return {
          ok: false,
          error: `threshold ${formatTokens(parsed.value)} exceeds the maximum ${formatTokens(defaultThreshold)} (window ${formatTokens(window)} - output ${formatTokens(outputReserve)} - ${formatTokens(AUTOCOMPACT_BUFFER_TOKENS)} buffer)`,
        };
      }
      threshold = parsed.value;
      source = "tokens";
    }
    if (threshold < MIN_THRESHOLD_TOKENS) {
      return {
        ok: false,
        error: `threshold ${formatTokens(threshold)} is below the minimum ${formatTokens(MIN_THRESHOLD_TOKENS)}`,
      };
    }
  }

  return {
    ok: true,
    value: {
      contextWindow,
      window,
      outputReserve,
      effectiveWindow,
      threshold,
      warning: threshold - WARNING_BUFFER_TOKENS,
      blocking: contextWindow - outputReserve - BLOCKING_BUFFER_TOKENS,
      precompute: Math.min(effectiveWindow - Math.round(effectiveWindow * PRECOMPUTE_BUFFER_FRACTION), threshold),
      source,
    },
  };
}

export type ContextLevel = "ok" | "warn" | "compact" | "blocked";

export function contextLevel(tokens: number, thresholds: CompactThresholds): ContextLevel {
  if (tokens >= thresholds.blocking) return "blocked";
  if (tokens >= thresholds.threshold) return "compact";
  if (tokens >= thresholds.warning) return "warn";
  return "ok";
}

/** Percent of the compaction headroom left, as Claude Code's footer reports it. */
export function percentLeftUntilCompact(tokens: number, thresholds: CompactThresholds): number {
  return Math.max(0, Math.round(((thresholds.threshold - tokens) / thresholds.threshold) * 100));
}

/** Pi's own trigger: contextTokens > contextWindow - reserveTokens. */
export function piNativeThreshold(contextWindow: number, reserveTokens: number): number {
  return contextWindow - reserveTokens;
}

/** Reserve that puts Pi's own trigger at Claude Code's blocking limit, so it only fires as a last resort. */
export function safetyNetReserveTokens(maxTokens: number): number {
  return outputReserveTokens(maxTokens) + BLOCKING_BUFFER_TOKENS;
}
