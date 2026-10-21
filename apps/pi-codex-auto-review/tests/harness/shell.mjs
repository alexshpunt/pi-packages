export const shellQuote = (value) =>
    `'${String(value).replaceAll("'", "'\\''")}'`;
/** Windows system variables Node, Git Bash and PowerShell need; names are case-insensitive. */
export const WINDOWS_SYSTEM_ENVIRONMENT = [
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "PSModulePath",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "OS",
];
/** Environment-name matching with the host's case rules. */
export function environmentKeys(keys, platform = process.platform) {
    if (platform !== "win32") {
        const kept = new Set(keys);
        return (key) => kept.has(key);
    }
    const kept = new Set(
        [...keys, ...WINDOWS_SYSTEM_ENVIRONMENT].map((key) =>
            key.toUpperCase(),
        ),
    );
    return (key) => kept.has(key.toUpperCase());
}
export function workloadEnvironment(caller = {}, ambient = process.env) {
    const isKept = environmentKeys([
        "PATH",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "TERM",
        "TMPDIR",
        "TMP",
        "TEMP",
        "PI_GUARD_RUN_DIR",
    ]);
    return {
        ...Object.fromEntries(
            Object.entries(ambient).filter(([key]) => isKept(key)),
        ),
        ...caller,
    };
}
