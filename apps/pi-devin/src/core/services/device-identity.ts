import { Context, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { collectDeviceIdentity, nodeDeviceSystem, type DeviceIdentity } from "../protocol/device.ts";

export interface DeviceIdentitySourceShape {
  /** Reads the device values the request fingerprint is built from. Never fails: unreadable values become their documented empty value. */
  readonly collect: Effect.Effect<DeviceIdentity>;
}

/** Where request fingerprints get their device values. Each fingerprint provider collects once and keeps the result. */
export class DeviceIdentitySource extends Context.Service<DeviceIdentitySource, DeviceIdentitySourceShape>()("pi-devin/DeviceIdentitySource") {}

/** Reads this machine through the process and network APIs. */
export const NodeDeviceIdentitySource: Layer.Layer<DeviceIdentitySource, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(DeviceIdentitySource,
  Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) => ({ collect: collectDeviceIdentity(nodeDeviceSystem(spawner)) })));
