import { resolve } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/** Resolve the SDK supplied by Pi's extension loader, including global installs. */
export function getPiSDKEntryPath(): string {
    return resolve(getPackageDir(), "dist/index.js");
}
