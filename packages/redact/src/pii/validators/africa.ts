// South African identifiers, ported from codemap-search `src/redact/pii/validators/africa.rs`.
import {
    byteLength,
    calendarDate,
    clean,
    isAscii,
    isAsciiAlphabeticCode,
    isLuhnValid,
    number,
    todayUtc,
} from "./checksums.js";

export function isSouthAfricanIdValid(value: string): boolean {
    if (byteLength(value) !== 13 || !/^[0-9]{13}$/.test(value)) return false;
    if (!"012".includes(value[10] ?? "") || !"89".includes(value[11] ?? ""))
        return false;
    const today = todayUtc();
    const suffix = number(value.slice(0, 2));
    const year = (suffix > today.getUTCFullYear() % 100 ? 1900 : 2000) + suffix;
    const birth = calendarDate(
        year,
        number(value.slice(2, 4)),
        number(value.slice(4, 6)),
    );
    return birth !== undefined && birth <= today && isLuhnValid(value);
}

export function isCompanyRegistrationValid(raw: string): boolean {
    const value = raw.replace(/[a-z]+/g, (letters) => letters.toUpperCase());
    const parts = value.split("/");
    let year: number;
    const [first = "", second = "", third = ""] = parts;
    if (
        parts.length === 3 &&
        byteLength(first) === 4 &&
        /^[0-9]{6}$/.test(second) &&
        /^[0-9]{2}$/.test(third)
    )
        year = number(first);
    else if (parts.length === 2 && /^[0-9]{6}$/.test(second)) {
        const prefix = ["CK", "NR", "K", "T", "W", "B", "M", "N"].find(
            (part) =>
                first.startsWith(part) &&
                byteLength(first.slice(part.length)) === 4,
        );
        if (prefix === undefined) return false;
        year = number(first.slice(prefix.length));
    } else return false;
    return year >= 1800 && year <= new Date().getUTCFullYear();
}

export function isLicencePlateValid(raw: string): boolean {
    const value = clean(raw);
    if (value.length < 5 || !isAscii(value)) return false;
    const province = value.slice(-2);
    return (
        ["GP", "ZN", "WP", "EC", "NC", "FS", "LP", "MP", "NW"].includes(
            province,
        ) &&
        [...value.slice(0, -2)].some((character) =>
            isAsciiAlphabeticCode(character.charCodeAt(0)),
        )
    );
}
