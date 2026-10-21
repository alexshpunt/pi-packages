import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/** Resolve the SDK supplied by Pi's extension loader, including global installs. */
export function getPiSDKEntryPath(): string {
    return resolve(getPackageDir(), "dist/index.js");
}

/** Evidence only: an unset execution path must still use Pi's platform resolver. */
export async function shellIdentity(shellPath?: string): Promise<string> {
    if (shellPath) return shellPath;
    try {
        const host = await import(
            new URL("utils/shell.js", pathToFileURL(getPiSDKEntryPath())).href
        );
        if (typeof host.getShellConfig === "function") {
            const config = host.getShellConfig();
            if (typeof config.shell === "string" && config.shell)
                return config.shell;
        }
    } catch {}
    return "pi-default-shell-unresolved";
}
