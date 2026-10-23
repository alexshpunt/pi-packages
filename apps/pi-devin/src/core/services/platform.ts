import { Effect, Layer, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// Subpath imports: the package index also loads NodeRedis, whose `redis` peer Pi's installer does not install.
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { DevinError, toDevinError } from "../errors.ts";

/** Keeps the operating system's own message and error code, as the Node APIs reported them. */
export function fromPlatformError(error: PlatformError): DevinError {
  const cause = error.reason.cause;
  return cause === undefined ? new DevinError({ message: error.message }) : toDevinError(cause);
}

/** Node implementations of the process and file services this package uses. */
export const NodePlatformLayer = Layer.mergeAll(
  NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  NodeFileSystem.layer,
  NodePath.layer,
);

export interface CommandOutputOptions {
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

/** Runs a fixed command without a shell input and returns its stdout, like `execFileSync` with an output bound. */
export function commandOutput(file: string, args: readonly string[], options: CommandOutputOptions): Effect.Effect<string, DevinError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.scoped(Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make(file, [...args], {
      env: options.env, extendEnv: false, detached: false, stdin: "ignore", stderr: "ignore",
    })).pipe(Effect.mapError(fromPlatformError));
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    yield* handle.stdout.pipe(
      Stream.mapError(fromPlatformError),
      Stream.runForEach((chunk) => {
        bytes += chunk.byteLength;
        if (bytes > options.maxOutputBytes) return Effect.fail(new DevinError({ message: `${file} output exceeds ${options.maxOutputBytes} bytes.` }));
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    const exitCode = yield* handle.exitCode.pipe(Effect.mapError(fromPlatformError));
    if (exitCode !== 0) return yield* Effect.fail(new DevinError({ message: `${file} exited with code ${exitCode}.` }));
    return Buffer.concat(chunks).toString("utf8");
  })).pipe(Effect.timeoutOrElse({
    duration: options.timeoutMs,
    orElse: () => Effect.fail(new DevinError({ message: `${file} timed out after ${options.timeoutMs}ms.`, code: "ETIMEDOUT" })),
  }));
}
