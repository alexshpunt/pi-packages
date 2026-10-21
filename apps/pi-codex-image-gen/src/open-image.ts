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
        return "SSH 세션에서는 원격 컴퓨터에서 열리므로 열지 않습니다.";
    }
    if (
        platform !== "darwin" &&
        platform !== "win32" &&
        !env.DISPLAY &&
        !env.WAYLAND_DISPLAY
    ) {
        return "그래픽 화면(DISPLAY 또는 WAYLAND_DISPLAY)이 없어 열 수 없습니다.";
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
        throw new Error(`저장된 파일을 찾을 수 없습니다: ${path}`);
    }
    const [command, args] = defaultAppLauncher(path, process.platform);
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.once("error", (error) =>
            reject(
                new Error(
                    `${command}을(를) 실행하지 못했습니다: ${error.message}`,
                ),
            ),
        );
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}
