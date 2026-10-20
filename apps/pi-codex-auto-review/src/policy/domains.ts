import { isIP } from "node:net";
export function normalizeHost(host: string): string {
    const value = host.toLowerCase().replace(/\.+$/, "");
    const literal =
        value.startsWith("[") && value.endsWith("]")
            ? value.slice(1, -1)
            : value;
    return isIP(literal) === 6
        ? new URL(`http://[${literal}]/`).hostname.slice(1, -1)
        : value;
}
export function isNetworkHost(host: unknown): boolean {
    return (
        typeof host === "string" &&
        (isIP(normalizeHost(host)) === 6 || /^[a-z0-9][a-z0-9.-]*$/i.test(host))
    );
}
export function isDomainPattern(pattern: unknown): pattern is string {
    return (
        typeof pattern === "string" &&
        (isNetworkHost(pattern) ||
            (pattern.startsWith("*.") &&
                /^[a-z0-9][a-z0-9.-]*$/i.test(pattern.slice(2))))
    );
}
/** Shared with the native configuration so policy and transport agree on subdomains. */
export function matchesDomain(host: string, pattern: string): boolean {
    const value = normalizeHost(host),
        rule = normalizeHost(pattern);
    return rule.startsWith("*.")
        ? value.endsWith(rule.slice(1)) && value !== rule.slice(2)
        : value === rule;
}
