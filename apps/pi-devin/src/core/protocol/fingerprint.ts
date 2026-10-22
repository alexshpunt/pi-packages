import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { toDevinError, type DevinError } from "../errors.ts";
import { failWith } from "../validation.ts";
import type { DeviceIdentity } from "./device.ts";

// Matches the CLI's fingerprint construction; verified with fake-token requests only.
// This is not encryption for credential storage. f contains the API token, so it is never logged.
const KEY_MATERIAL = "df97465349f38646af1d66c263e25e08";
const KEY = createHash("sha256").update(KEY_MATERIAL, "utf8").digest();

export interface FingerprintProvider {
  /** A new ciphertext per request: the same device, a fresh timestamp and nonce. */
  readonly create: Effect.Effect<string, DevinError>;
  /** The device hash, collected once on first use. */
  readonly device: Effect.Effect<string, DevinError>;
}

export function hashDeviceIdentity(identity: DeviceIdentity): string {
  const macs = Buffer.byteLength(identity.serial) >= 4 ? "" : identity.macs.join(",");
  return createHash("sha512").update(macs + identity.serial + identity.username, "utf8").digest("hex");
}

export interface FingerprintOptions {
  /** Device values for this provider. Collected on first use and kept; concurrent first requests share one collection. */
  collectIdentity: Effect.Effect<DeviceIdentity, DevinError>;
  nowNanoseconds?: () => bigint;
  nonce?: () => Uint8Array;
}

export function makeFingerprintProvider(sessionToken: string, options: FingerprintOptions): Effect.Effect<FingerprintProvider> {
  return Effect.map(Effect.cached(Effect.map(options.collectIdentity, hashDeviceIdentity)), (device) => ({
    device,
    create: Effect.flatMap(device, (deviceFingerprint) => encodeFingerprint({
      deviceFingerprint, sessionToken, timestampNanoseconds: options.nowNanoseconds?.(), nonce: options.nonce?.(),
    })),
  }));
}

export function unixNanoseconds(): bigint {
  // High-resolution epoch clock from the public Node API. It does not guarantee the OS's raw CLOCK_REALTIME precision.
  const originMilliseconds = Math.trunc(performance.timeOrigin);
  const fractionalNanoseconds = Math.round((performance.timeOrigin - originMilliseconds + performance.now()) * 1_000_000);
  return BigInt(originMilliseconds) * 1_000_000n + BigInt(fractionalNanoseconds);
}

export function encodeFingerprint(options: {
  deviceFingerprint: string;
  sessionToken: string;
  timestampNanoseconds?: bigint;
  nonce?: Uint8Array;
}): Effect.Effect<string, DevinError> {
  return Effect.suspend(() => {
    if (!/^[0-9a-f]{128}$/.test(options.deviceFingerprint)) return failWith("The device identifier must be 128 lowercase hex characters.");
    if (!options.sessionToken || /[|\s\u0000-\u001f\u007f]/.test(options.sessionToken)) return failWith("Invalid session token format.");
    const timestamp = options.timestampNanoseconds ?? unixNanoseconds();
    if (timestamp < 0n || timestamp >= (1n << 128n)) return failWith("Invalid fingerprint timestamp.");
    const nonce = options.nonce ?? randomBytes(12);
    if (nonce.length !== 12) return failWith("The fingerprint nonce must be 12 bytes.");
    const plaintext = `${options.deviceFingerprint}|${options.sessionToken}|${timestamp}`;
    return Effect.try({
      try: () => {
        const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("hex");
      },
      catch: toDevinError,
    });
  });
}
