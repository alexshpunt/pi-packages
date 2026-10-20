import { homedir } from "node:os";
import { join } from "node:path";

/** Testing hook: pretend to run on another platform (`darwin`, `win32`, `linux`, ...). */
export const PLATFORM_OVERRIDE_VARIABLE = "PI_CODEX_COMPUTER_USE_PLATFORM";
/** Testing hook: use this Codex Desktop app bundle instead of the default locations (macOS). */
export const APP_PATH_OVERRIDE_VARIABLE = "PI_CODEX_COMPUTER_USE_APP_PATH";
/** Codex's own state directory variable; defaults to `~/.codex` like Codex does. */
export const CODEX_HOME_VARIABLE = "CODEX_HOME";

/** Codex Desktop models Computer Use for macOS and Windows only (codex-rs/config/src/computer_use.rs). */
export type SupportedPlatform = "darwin" | "win32";

/** `verified` means this package was exercised on the platform; `unverified` means implemented from documentation only. */
export type PlatformVerification = "verified" | "unverified";

export interface SupportedPlatformInfo {
    supported: true;
    platform: SupportedPlatform;
    label: string;
    verification: PlatformVerification;
    /** True when the platform comes from the override variable and differs from the host. */
    isSimulated: boolean;
}

export interface UnsupportedPlatformInfo {
    supported: false;
    platform: string;
    label: string;
    isSimulated: boolean;
}

export type PlatformInfo = SupportedPlatformInfo | UnsupportedPlatformInfo;

const PLATFORM_LABELS: Record<string, string> = {
    darwin: "macOS",
    win32: "Windows",
    linux: "Linux",
};

export function detectPlatform(
    env: NodeJS.ProcessEnv = process.env,
    hostPlatform: string = process.platform,
): PlatformInfo {
    const override = env[PLATFORM_OVERRIDE_VARIABLE]?.trim();
    const platform = override || hostPlatform;
    const isSimulated = platform !== hostPlatform;
    const label = PLATFORM_LABELS[platform] ?? platform;
    if (platform === "darwin")
        return {
            supported: true,
            platform,
            label,
            verification: "verified",
            isSimulated,
        };
    if (platform === "win32")
        return {
            supported: true,
            platform,
            label,
            verification: "unverified",
            isSimulated,
        };
    return { supported: false, platform, label, isSimulated };
}

/** Mirrors Codex: `CODEX_HOME` when set and non-empty, otherwise `<home>/.codex`. */
export function resolveCodexHome(
    platform: PlatformInfo,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const explicit = env[CODEX_HOME_VARIABLE]?.trim();
    if (explicit) return explicit;
    if (
        platform.supported &&
        platform.platform === "win32" &&
        !platform.isSimulated
    ) {
        const profile = env.USERPROFILE?.trim();
        if (profile) return join(profile, ".codex");
    }
    return join(homedir(), ".codex");
}

export function describePlatform(platform: PlatformInfo): string {
    const simulated = platform.isSimulated ? ", simulated" : "";
    if (!platform.supported)
        return `${platform.label} (unsupported${simulated})`;
    const verification =
        platform.verification === "verified" ? "verified" : "untested";
    return `${platform.label} (${verification}${simulated})`;
}
