import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/** Resolve the SDK supplied by Pi's extension loader, including global installs. */
export function getPiSDKEntryPath(): string {
    return resolve(getPackageDir(), "dist/index.js");
}

async function hostShell(
    resolver: "getShellConfig" | "getPowerShellConfig",
): Promise<string> {
    try {
        const host = await import(
            new URL("utils/shell.js", pathToFileURL(getPiSDKEntryPath())).href
        );
        if (typeof host[resolver] === "function") {
            const config = host[resolver]();
            if (typeof config.shell === "string" && config.shell)
                return config.shell;
        }
    } catch {}
    return "pi-default-shell-unresolved";
}
/** Evidence only: an unset execution path must still use Pi's platform resolver. */
export async function shellIdentity(shellPath?: string): Promise<string> {
    return shellPath || hostShell("getShellConfig");
}
/** Evidence only: Pi resolves `pwsh.exe`, then `powershell.exe`, for every PowerShell call. */
export async function powershellIdentity(): Promise<string> {
    return hostShell("getPowerShellConfig");
}
