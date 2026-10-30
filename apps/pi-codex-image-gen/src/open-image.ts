import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

/**
 * Why the platform default app cannot show a file to the person at this terminal, or
 * `undefined` when it can. Over SSH the app would open on the remote machine, and Linux or
 * other Unix systems without a graphical session have nowhere to show it.
 */
export function defaultAppUnavailableReason(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string | undefined {
    if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
        return "Cannot open an image on the remote computer over SSH.";
    }
    if (
        platform !== "darwin" &&
        platform !== "win32" &&
        !env.DISPLAY &&
        !env.WAYLAND_DISPLAY
    ) {
        return "Cannot open an image without a graphical session (DISPLAY or WAYLAND_DISPLAY).";
    }
    return undefined;
}

/** The same launchers Pi uses for links; none of them goes through a shell. */
function defaultAppLauncher(
    path: string,
    platform: NodeJS.Platform,
): [string, string[]] {
    if (platform === "darwin") return ["open", [path]];
    if (platform === "win32")
        return ["rundll32", ["url.dll,FileProtocolHandler", path]];
    return ["xdg-open", [path]];
}

/**
 * Opens a saved image with the platform default app. Resolves once the launcher process has
 * started; whether the app then shows the file is up to the launcher.
 */
export async function openWithDefaultApp(path: string): Promise<void> {
    const unavailableReason = defaultAppUnavailableReason();
    if (unavailableReason !== undefined) throw new Error(unavailableReason);
    try {
        await access(path);
    } catch {
        throw new Error(`Saved file not found: ${path}`);
    }
    const [command, args] = defaultAppLauncher(path, process.platform);
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.once("error", (error) =>
            reject(new Error(`Could not start ${command}: ${error.message}`)),
        );
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}
