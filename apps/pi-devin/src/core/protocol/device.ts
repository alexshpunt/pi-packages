import { execFileSync } from "node:child_process";
import { networkInterfaces, userInfo, type NetworkInterfaceInfo } from "node:os";

export interface DeviceIdentity {
  serial: string;
  macs: string[];
  username: string;
}

/** OS inputs read by device collection. Tests control only this boundary; collection rules and the fingerprint computation run unchanged. */
export interface DeviceSystem {
  platform: NodeJS.Platform;
  run(file: string, args: string[]): string;
  networkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
  username(): string;
}

// The MAC collection shell input is a fixed string and never includes user input.
const MAC_COMMAND = `ifconfig 2>/dev/null | awk '/^[a-z]/{iface=$1} /inet6? /{has_ip[iface]=1} /ether /{mac[iface]=$2} END{for(i in has_ip) if(mac[i] && mac[i]!="00:00:00:00:00:00") print mac[i]}' | tr '[:upper:]' '[:lower:]' | sort -u`;
const COMMAND_OPTIONS = {
  encoding: "utf8" as const, timeout: 3000, maxBuffer: 1024 * 1024,
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
};

function nodeDeviceSystem(): DeviceSystem {
  return {
    platform: process.platform,
    run: (file, args) => execFileSync(file, args, COMMAND_OPTIONS),
    networkInterfaces,
    username: () => userInfo().username,
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
 */
export function collectDeviceIdentity(system: DeviceSystem = nodeDeviceSystem()): DeviceIdentity {
  const isDarwin = system.platform === "darwin";
  let serial = "";
  if (isDarwin) {
    try {
      const result = system.run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      const match = result.match(/"IOPlatformSerialNumber"\s*=\s*("(?:\\.|[^"\\])*")/);
      if (match) serial = JSON.parse(match[1]) as string;
    } catch { /* A failed serial read becomes an empty value. The output may be sensitive, so it is not included in errors. */ }
  }
  let macs: string[] = [];
  if (Buffer.byteLength(serial) < 4) {
    try {
      macs = isDarwin
        ? system.run("/bin/sh", ["-c", MAC_COMMAND]).split(/\r?\n/).filter(Boolean)
        : interfaceMACs(system.networkInterfaces());
    } catch { /* A failed MAC collection yields an empty list. */ }
  }
  let username = "unknown";
  try { username = system.username(); } catch { /* value used when the system call fails */ }
  return { serial, macs, username };
}
