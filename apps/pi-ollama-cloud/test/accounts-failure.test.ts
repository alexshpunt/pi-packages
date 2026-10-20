import { describe, expect, it } from "vitest";
import {
  classifyAccountFailure,
  classifyProviderMessage,
  classifyThrownError,
  statusFromMessage,
} from "../src/accounts/failure.ts";
import { httpError, OllamaHttpError } from "../src/shared/http.ts";

const sessionLimit =
  "you (fixture) have reached your session usage limit, upgrade for higher limits: https://ollama.com/upgrade (ref: x)";
const weeklyLimit = "you (fixture) have reached your weekly usage limit, upgrade for higher limits (ref: x)";
const monthlyLimit = "you (fixture) have reached your monthly usage limit, upgrade for higher limits";

function thrown(run: () => never): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a throw");
}

describe("statusFromMessage", () => {
  it("reads provider, web-fetch, and HTTP-helper status formats", () => {
    expect(statusFromMessage(`429 ${sessionLimit}`)).toBe(429);
    expect(statusFromMessage('429: {"error":"x"}')).toBe(429);
    expect(statusFromMessage("Ollama Cloud fetch failed: url\nAPI error: HTTP 401: unauthorized")).toBe(401);
    expect(statusFromMessage("Ollama Cloud search failed: server error (status 503). Try again shortly.")).toBe(503);
    expect(statusFromMessage("connection reset")).toBeUndefined();
  });
});

describe("classifyAccountFailure", () => {
  it("names the exhausted usage window", () => {
    expect(classifyAccountFailure(429, sessionLimit)).toEqual({ kind: "usage-limit", window: "session" });
    expect(classifyAccountFailure(429, weeklyLimit)).toEqual({ kind: "usage-limit", window: "weekly" });
    expect(classifyAccountFailure(429, monthlyLimit)).toEqual({ kind: "usage-limit", window: "monthly" });
    expect(classifyAccountFailure(undefined, "usage limit reached for this key")).toEqual({
      kind: "usage-limit",
      window: "unknown",
    });
  });

  it("separates credential failures from throttling, server, and request errors", () => {
    expect(classifyAccountFailure(401, "unauthorized")).toEqual({ kind: "unauthorized" });
    expect(classifyAccountFailure(403, "forbidden")).toEqual({ kind: "forbidden" });
    expect(classifyAccountFailure(429, "too many concurrent requests")).toBeUndefined();
    expect(classifyAccountFailure(500, "internal error")).toBeUndefined();
    expect(classifyAccountFailure(0, "fetch failed")).toBeUndefined();
    // Usage-limit wording with a non-429 status is not treated as quota exhaustion.
    expect(classifyAccountFailure(400, "usage limit parameter is invalid")).toBeUndefined();
  });
});

describe("classifyProviderMessage", () => {
  it("classifies Pi's provider error messages", () => {
    expect(classifyProviderMessage(`429 ${weeklyLimit}`)).toEqual({ kind: "usage-limit", window: "weekly" });
    expect(classifyProviderMessage("401 invalid api key")).toEqual({ kind: "unauthorized" });
    expect(classifyProviderMessage("429 rate limit exceeded")).toBeUndefined();
    expect(classifyProviderMessage(undefined)).toBeUndefined();
  });
});

describe("classifyThrownError and httpError", () => {
  it("keeps the usage-limit detail that a plain rate-limit message would drop", () => {
    const error = thrown(() => httpError("search", 429, monthlyLimit));
    expect(error).toBeInstanceOf(OllamaHttpError);
    expect((error as Error).message).toContain("usage limit reached");
    expect((error as Error).message).toContain("monthly usage limit");
    expect(classifyThrownError(error)).toEqual({ kind: "usage-limit", window: "monthly" });
  });

  it("preserves existing messages for throttling and authentication", () => {
    const throttled = thrown(() => httpError("search", 429, "rate limited"));
    expect((throttled as Error).message).toBe("Ollama Cloud search failed: rate limited. Try again shortly.");
    expect(classifyThrownError(throttled)).toBeUndefined();
    const unauthorized = thrown(() => httpError("balance", 401, "unauthorized"));
    expect((unauthorized as Error).message).toMatch(/authentication error/);
    expect(classifyThrownError(unauthorized)).toEqual({ kind: "unauthorized" });
  });

  it("classifies web-fetch failure text and ignores unknown values", () => {
    const fetchFailure = new Error(`Ollama Cloud fetch failed: https://x.test\nAPI error: HTTP 429: ${sessionLimit}`);
    expect(classifyThrownError(fetchFailure)).toEqual({ kind: "usage-limit", window: "session" });
    expect(classifyThrownError({ unexpected: true })).toBeUndefined();
  });
});
