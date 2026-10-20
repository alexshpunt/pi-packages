export const shellQuote = (value) =>
    `'${String(value).replaceAll("'", "'\\''")}'`;
export function workloadEnvironment(caller = {}, ambient = process.env) {
    const keys = new Set([
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
            Object.entries(ambient).filter(([key]) => keys.has(key)),
        ),
        ...caller,
    };
}
