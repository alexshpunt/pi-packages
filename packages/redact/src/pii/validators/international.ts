// IBAN, IP, e-mail, MAC, and UUID validation ported from
// codemap-search `src/redact/pii/validators/international.rs`.
import { clean, isAscii, utf8Bytes } from "./checksums.js";

/** Country prefix to a sticky format pattern (upstream exact_match=false matches a prefix). */
export type IbanFormats = ReadonlyMap<string, RegExp>;

function formatMatch(
    formats: IbanFormats,
    value: string,
): RegExpExecArray | null {
    const format = formats.get(value.slice(0, 2));
    if (!format) return null;
    format.lastIndex = 0;
    return format.exec(value);
}

export function hasExactIbanLength(formats: IbanFormats, raw: string): boolean {
    const value = clean(raw);
    return formatMatch(formats, value)?.[0].length === value.length;
}

export function isIbanValid(formats: IbanFormats, raw: string): boolean {
    const value = clean(raw);
    if (value.length < 4 || !isAscii(value)) return false;
    if (!formatMatch(formats, value)) return false;
    let remainder = 0;
    for (const character of value.slice(4) + value.slice(0, 4)) {
        const code = character.charCodeAt(0);
        if (code >= 0x30 && code <= 0x39)
            remainder = (remainder * 10 + code - 0x30) % 97;
        else if (code >= 0x41 && code <= 0x5a)
            remainder = (remainder * 100 + code - 0x41 + 10) % 97;
        else return false;
    }
    return remainder === 1;
}

// `std::net::IpAddr` parsing: dotted IPv4 without leading zeros, IPv6 groups
// with optional `::` and a trailing embedded IPv4 address.
class AddressParser {
    position = 0;
    constructor(readonly text: string) {}

    atomically<T>(read: () => T | undefined): T | undefined {
        const start = this.position;
        const result = read();
        if (result === undefined) this.position = start;
        return result;
    }

    readCharacter(expected: string): true | undefined {
        if (this.text[this.position] !== expected) return undefined;
        this.position++;
        return true;
    }

    readNumber(
        radix: 10 | 16,
        maximumDigits: number,
        maximum: number,
        allowsZeroPrefix: boolean,
    ): number | undefined {
        return this.atomically(() => {
            const hasLeadingZero = this.text[this.position] === "0";
            let value = 0;
            let count = 0;
            for (;;) {
                const digit = Number.parseInt(
                    this.text[this.position] ?? "",
                    radix,
                );
                const character = this.text[this.position] ?? "";
                if (
                    Number.isNaN(digit) ||
                    !/^[0-9A-Fa-f]$/.test(character) ||
                    (radix === 10 && !/^[0-9]$/.test(character))
                )
                    break;
                this.position++;
                value = value * radix + digit;
                if (value > maximum) return undefined;
                count++;
                if (count > maximumDigits) return undefined;
            }
            if (count === 0) return undefined;
            if (!allowsZeroPrefix && hasLeadingZero && count > 1)
                return undefined;
            return value;
        });
    }

    readSeparated<T>(index: number, read: () => T | undefined): T | undefined {
        return this.atomically(() => {
            if (index > 0 && this.readCharacter(":") === undefined)
                return undefined;
            return read();
        });
    }

    readIpv4(): true | undefined {
        return this.atomically(() => {
            for (let index = 0; index < 4; index++) {
                if (index > 0 && this.readCharacter(".") === undefined)
                    return undefined;
                if (this.readNumber(10, 3, 255, false) === undefined)
                    return undefined;
            }
            return true;
        });
    }

    /** Returns the number of 16-bit groups read and whether an IPv4 tail ended them. */
    readGroups(limit: number): [count: number, hasIpv4: boolean] {
        for (let index = 0; index < limit; index++) {
            if (
                index < limit - 1 &&
                this.readSeparated(index, () => this.readIpv4())
            )
                return [index + 2, true];
            if (
                this.readSeparated(index, () =>
                    this.readNumber(16, 4, 0xffff, true),
                ) === undefined
            )
                return [index, false];
        }
        return [limit, false];
    }

    readIpv6(): true | undefined {
        return this.atomically(() => {
            const [headSize, hasHeadIpv4] = this.readGroups(8);
            if (headSize === 8) return true;
            if (hasHeadIpv4) return undefined;
            if (
                this.readCharacter(":") === undefined ||
                this.readCharacter(":") === undefined
            )
                return undefined;
            this.readGroups(8 - (headSize + 1));
            return true;
        });
    }

    isAtEnd(): boolean {
        return this.position === this.text.length;
    }
}

function ipVersion(host: string): 4 | 6 | undefined {
    const ipv4 = new AddressParser(host);
    if (ipv4.readIpv4() && ipv4.isAtEnd()) return 4;
    const ipv6 = new AddressParser(host);
    if (ipv6.readIpv6() && ipv6.isAtEnd()) return 6;
    return undefined;
}

export function isIpValid(value: string): boolean {
    const slash = value.indexOf("/");
    const address = slash === -1 ? value : value.slice(0, slash);
    const prefix = slash === -1 ? undefined : value.slice(slash + 1);
    const percent = address.indexOf("%");
    const version = ipVersion(
        percent === -1 ? address : address.slice(0, percent),
    );
    if (version === undefined) return false;
    if (prefix === undefined) return true;
    if (!/^\+?[0-9]+$/.test(prefix)) return false;
    const length = Number(prefix.replace(/^\+/, ""));
    return length <= 255 && length <= (version === 4 ? 32 : 128);
}

export function isEmailValid(value: string): boolean {
    // Keep host validation local. No public-suffix downloads or tldextract runtime.
    const at = value.lastIndexOf("@");
    if (at === -1) return false;
    const local = value.slice(0, at);
    const host = value.slice(at + 1);
    return (
        local !== "" &&
        host.includes(".") &&
        host
            .split(".")
            .every(
                (label) =>
                    label !== "" &&
                    !label.startsWith("-") &&
                    !label.endsWith("-"),
            )
    );
}

export function isMacValid(raw: string): boolean {
    const value = clean(raw);
    return (
        value.length === 12 &&
        /^[0-9A-Fa-f]{12}$/.test(value) &&
        value !== "FFFFFFFFFFFF" &&
        value !== "000000000000"
    );
}

export function isUuidValid(value: string): boolean {
    const bytes = utf8Bytes(value);
    const version = bytes[14];
    const variant = bytes[19];
    return (
        version !== undefined &&
        version >= 0x31 &&
        version <= 0x38 &&
        variant !== undefined &&
        [0x38, 0x39, 0x61, 0x62].includes(
            variant >= 0x41 && variant <= 0x5a ? variant + 0x20 : variant,
        )
    );
}
