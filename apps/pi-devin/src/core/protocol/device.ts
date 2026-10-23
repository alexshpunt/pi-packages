import { networkInterfaces, userInfo, type NetworkInterfaceInfo } from "node:os";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { toDevinError, type DevinError } from "../errors.ts";
import { commandOutput } from "../services/platform.ts";

export interface DeviceIdentity {
  serial: string;
  macs: string[];
  username: string;
}

/** OS inputs read by device collection. Tests control only this boundary; collection rules and the fingerprint computation run unchanged. */
export interface DeviceSystem {
  platform: NodeJS.Platform;
  run(file: string, args: readonly string[]): Effect.Effect<string, DevinError>;
  networkInterfaces(): Effect.Effect<NodeJS.Dict<NetworkInterfaceInfo[]>, DevinError>;
  username(): Effect.Effect<string, DevinError>;
}

// The MAC collection shell input is a fixed string and never includes user input.
const MAC_COMMAND = `ifconfig 2>/dev/null | awk '/^[a-z]/{iface=$1} /inet6? /{has_ip[iface]=1} /ether /{mac[iface]=$2} END{for(i in has_ip) if(mac[i] && mac[i]!="00:00:00:00:00:00") print mac[i]}' | tr '[:upper:]' '[:lower:]' | sort -u`;
const COMMAND_OPTIONS = { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }, timeoutMs: 3000, maxOutputBytes: 1024 * 1024 };

/** This machine's OS inputs. Commands run through the given process spawner. */
export function nodeDeviceSystem(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): DeviceSystem {
  return {
    platform: process.platform,
    run: (file, args) => commandOutput(file, args, COMMAND_OPTIONS).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    networkInterfaces: () => Effect.try({ try: () => networkInterfaces(), catch: toDevinError }),
    username: () => Effect.try({ try: () => userInfo().username, catch: toDevinError }),
  };
}

/** MAC collection conditions: non-zero MACs of interfaces that have an address, lowercased, deduplicated and sorted. */
function interfaceMACs(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const macs = new Set<string>();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      const mac = address.mac.toLowerCase();
      if (mac && mac !== "00:00:00:00:00:00") macs.add(mac);
    }
  }
  return [...macs].sort();
}

/**
 * Device values are used only for the fingerprint. Credentials and settings of an installed CLI are never read.
 * macOS reads ioreg/ifconfig. Serial collection on other OSes is unverified, so the
 * serial is left empty instead of being invented; MACs come from the common Node API under the same conditions.
 * Every failed read becomes the documented empty value; the output may be sensitive, so it never reaches an error.
 */
export function collectDeviceIdentity(system: DeviceSystem): Effect.Effect<DeviceIdentity> {
  return Effect.gen(function* () {
    const isDarwin = system.platform === "darwin";
    let serial = "";
    if (isDarwin) {
      const output = yield* system.run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]).pipe(Effect.orElseSucceed(() => ""));
      const match = output.match(/"IOPlatformSerialNumber"\s*=\s*("(?:\\.|[^"\\])*")/);
      if (match) serial = yield* Effect.try({ try: () => JSON.parse(match[1]) as string, catch: () => "" }).pipe(Effect.orElseSucceed(() => ""));
    }
    let macs: string[] = [];
    if (Buffer.byteLength(serial) < 4) {
      macs = yield* (isDarwin
        ? Effect.map(system.run("/bin/sh", ["-c", MAC_COMMAND]), (output) => output.split(/\r?\n/).filter(Boolean))
        : Effect.map(system.networkInterfaces(), interfaceMACs)
      ).pipe(Effect.orElseSucceed((): string[] => []));
    }
    const username = yield* system.username().pipe(Effect.orElseSucceed(() => "unknown"));
    return { serial, macs, username };
  });
}
