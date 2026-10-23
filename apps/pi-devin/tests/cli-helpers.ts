import { Effect, Layer } from "effect";
import { SessionStore, SessionStoreLive } from "../src/cli/services/sessions.ts";
import { StateFiles, StateFilesAt } from "../src/cli/services/state-files.ts";
import { NodePlatformLayer } from "../src/core/services/platform.ts";

// Kept apart from helpers.ts: the provider suites also run against the npm archive, which has no CLI.
/** The CLI's state files around an explicit credential file, on the real file system. */
export const stateFiles = (credentialFile: string) => Effect.runSync(Effect.provide(Effect.gen(function* () { return yield* StateFiles; }),
  StateFilesAt(credentialFile).pipe(Layer.provide(NodePlatformLayer))));

/** The CLI's session store next to an explicit credential file. */
export const sessionStore = (credentialFile: string) => Effect.runSync(Effect.provide(Effect.gen(function* () { return yield* SessionStore; }),
  SessionStoreLive.pipe(Layer.provide(StateFilesAt(credentialFile)), Layer.provide(NodePlatformLayer))));
