import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestCoordinator } from "../src/cache/coordinator.ts";
import { fetchModelIdsEffect } from "../src/models/api.ts";
import { awaitShared, fromPromise, fromSync, runAbortable } from "../src/shared/effects.ts";
import { fetchJsonWithTimeoutEffect, OllamaHttpError } from "../src/shared/http.ts";
import { fetchUsageEffect } from "../src/usage/api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Effect host boundaries and resource ownership", () => {
  it("preserves typed HTTP failures and arbitrary rejection identity", async () => {
    const error = new OllamaHttpError("limited", 429, "weekly usage limit");
    await expect(Effect.runPromise(fromPromise(() => Promise.reject(error)))).rejects.toBe(error);
    await expect(
      Effect.runPromise(
        fromSync(() => {
          throw error;
        }),
      ),
    ).rejects.toBe(error);
    await expect(Effect.runPromise(fromPromise(() => Promise.reject(undefined)))).rejects.toBeUndefined();
  });

  it("keeps validation and HTTP failures in the recoverable error channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ wrong: [] })),
    );
    const modelError = await Effect.runPromise(
      fetchModelIdsEffect().pipe(Effect.catch((error) => Effect.succeed(error))),
    );
    expect(modelError).toBeInstanceOf(Error);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("weekly usage limit", { status: 429 })),
    );
    const usageError = await Effect.runPromise(
      fetchUsageEffect("fixture").pipe(Effect.catch((error) => Effect.succeed(error))),
    );
    expect(usageError).toBeInstanceOf(OllamaHttpError);
    expect((usageError as OllamaHttpError).status).toBe(429);
  });

  it("waits for finalizers and returns the caller's original cancellation reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const released: string[] = [];
    const pending = runAbortable(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          released.push("acquired");
          return 1;
        }),
        () => Effect.never,
        () =>
          Effect.sync(() => {
            released.push("released");
          }),
      ),
      controller.signal,
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(released).toEqual(["acquired", "released"]);
  });

  it("cancels only one shared subscriber and removes its listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let finish!: (value: number) => void;
    const shared = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const cancelled = Effect.runPromise(awaitShared(shared, controller.signal));
    const retained = Effect.runPromise(awaitShared(shared));
    controller.abort("cancelled subscriber");
    await expect(cancelled).rejects.toBe("cancelled subscriber");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    finish(42);
    await expect(retained).resolves.toBe(42);
  });

  it.each(["success", "failure"])("removes shared subscriptions after %s", async (outcome) => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = outcome === "success" ? Promise.resolve(7) : Promise.reject("fixture failure");
    const result = Effect.runPromise(awaitShared(pending, controller.signal));
    if (outcome === "success") await expect(result).resolves.toBe(7);
    else await expect(result).rejects.toBe("fixture failure");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("keeps HTTP effects lazy and covers response-body consumption with the deadline scope", async () => {
    let requestSignal: AbortSignal | undefined;
    let startBody!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      startBody = resolve;
    });
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return {
        text: () => {
          startBody();
          return new Promise<string>((_resolve, reject) => {
            requestSignal?.addEventListener("abort", () => reject(new Error("aborted body")), { once: true });
          });
        },
      } as Response;
    });
    vi.stubGlobal("fetch", fetch);
    const program = fetchJsonWithTimeoutEffect("https://example.test", {}, 10000);
    expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController();
    const running = runAbortable(program, controller.signal);
    await bodyStarted;
    controller.abort("stop body");
    await expect(running).rejects.toBe("stop body");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("releases native shared jobs when the last Effect subscriber is interrupted", async () => {
    const coordinator = createRequestCoordinator<number>();
    const controller = new AbortController();
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let transportSignal: AbortSignal | undefined;
    let hasReleased = false;
    const pending = runAbortable(
      coordinator.runEffect({ key: "page", credential: "fixture" }, ({ signal }) => {
        transportSignal = signal;
        return Effect.gen(function* () {
          start();
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              hasReleased = true;
            }),
          ),
        );
      }),
      controller.signal,
    );
    await started;
    controller.abort("last subscriber");
    await expect(pending).rejects.toBe("last subscriber");
    await Promise.resolve();
    expect(transportSignal?.aborted).toBe(true);
    expect(hasReleased).toBe(true);
    expect(coordinator.getDiagnostics()).toEqual({ inFlight: 0, resources: 0 });
  });
});
