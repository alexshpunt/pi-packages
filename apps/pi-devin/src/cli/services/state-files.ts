import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Context, Effect, FileSystem, Layer, Predicate } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { DevinError } from "../../core/errors.ts";
import { endpoint } from "../../core/protocol/endpoint.ts";
import { fromPlatformError } from "../../core/services/platform.ts";
import type { Credential } from "../../core/types.ts";
import { failWith, object, requiredString } from "../../core/validation.ts";

export const isNotFound = (error: PlatformError) => error.reason._tag === "NotFound";
export const isAlreadyExists = (error: PlatformError) => error.reason._tag === "AlreadyExists";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The PoC's own state directory. Never the credentials or settings of an installed Devin CLI. */
export function stateDirectory(): string {
  return process.env.DEVIN_POC_STATE_DIR ?? join(homedir(), ".local", "share", "devin-protocol-poc");
}

/** Creates the directory with private permissions, also tightening an existing one. */
export function privateDirectory(path: string): Effect.Effect<void, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path, { recursive: true, mode: 0o700 });
    yield* fs.chmod(path, 0o700);
  }).pipe(Effect.mapError(fromPlatformError));
}

/** Writes a private file through a temporary sibling and a rename, so readers never see a partial file. */
export function writePrivateFile(file: string, text: string): Effect.Effect<void, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    yield* fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" }).pipe(
      Effect.andThen(fs.rename(temporary, file)),
      Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))),
      Effect.mapError(fromPlatformError),
    );
  });
}

export interface StateFilesShape {
  readonly credentialPath: string;
  readonly readCredential: Effect.Effect<Credential, DevinError>;
  readonly saveCredential: (credential: Credential) => Effect.Effect<void, DevinError>;
  /** Deletes only this PoC's local token; the server token is not revoked. */
  readonly removeCredential: Effect.Effect<void, DevinError>;
  /** A random installation ID created once. Concurrent first runs agree through an exclusive hard link. */
  readonly installationId: Effect.Effect<string, DevinError>;
}

/** The credential and installation files of the PoC CLI. */
export class StateFiles extends Context.Service<StateFiles, StateFilesShape>()("pi-devin/cli/StateFiles") {}

export function makeStateFiles(credentialPath: string): Effect.Effect<StateFilesShape, never, FileSystem.FileSystem> {
  return Effect.map(FileSystem.FileSystem, (fs) => {
    const withFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) => Effect.provideService(effect, FileSystem.FileSystem, fs);
    const directory = dirname(credentialPath);
    return {
      credentialPath,
      readCredential: Effect.gen(function* () {
        const text = yield* fs.readFileString(credentialPath).pipe(Effect.mapError((error) => isNotFound(error)
          ? new DevinError({ message: "No PoC credential found. Run login." }) : fromPlatformError(error)));
        const value = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => undefined }).pipe(
          Effect.flatMap((parsed) => object(parsed, "credential")),
          Effect.mapError(() => new DevinError({ message: "Invalid PoC credential file format." })),
        );
        if (value.version !== 1) return yield* failWith("Unsupported credential version.");
        const fingerprint = Predicate.isString(value.fingerprint) ? value.fingerprint : undefined;
        return {
          version: 1,
          sessionToken: yield* requiredString(value.sessionToken, "sessionToken"),
          apiServerURL: yield* endpoint(yield* requiredString(value.apiServerURL, "apiServerURL")),
          ...(fingerprint !== undefined ? { fingerprint } : {}),
          createdAt: yield* requiredString(value.createdAt, "createdAt"),
        } satisfies Credential;
      }),
      saveCredential: (credential) => withFileSystem(Effect.andThen(privateDirectory(directory), writePrivateFile(credentialPath, JSON.stringify(credential, null, 2) + "\n"))),
      removeCredential: fs.remove(credentialPath, { force: true }).pipe(Effect.mapError(fromPlatformError)),
      installationId: withFileSystem(Effect.gen(function* () {
        const path = join(directory, "installation-id");
        yield* privateDirectory(directory);
        const temporary = `${path}.${randomUUID()}.tmp`;
        yield* fs.writeFileString(temporary, randomUUID() + "\n", { flag: "wx", mode: 0o600 }).pipe(
          Effect.andThen(fs.link(temporary, path).pipe(Effect.catch((error) => isAlreadyExists(error) ? Effect.void : Effect.fail(error)))),
          Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))),
          Effect.mapError(fromPlatformError),
        );
        const info = yield* fs.stat(path).pipe(Effect.mapError(fromPlatformError));
        if (Number(info.size) > 128) return yield* failWith("Invalid installation ID file.");
        const value = (yield* fs.readFileString(path).pipe(Effect.mapError(fromPlatformError))).trim();
        if (!UUID.test(value)) return yield* failWith("Invalid installation ID format.");
        return value;
      })),
    } satisfies StateFilesShape;
  });
}

/** The state files under `DEVIN_POC_STATE_DIR`, or the default directory, as of this run. */
export const StateFilesLive = Layer.effect(StateFiles, Effect.suspend(() => makeStateFiles(join(stateDirectory(), "credentials.json"))));
/** State files around an explicit credential file. */
export const StateFilesAt = (credentialPath: string) => Layer.effect(StateFiles, makeStateFiles(credentialPath));
