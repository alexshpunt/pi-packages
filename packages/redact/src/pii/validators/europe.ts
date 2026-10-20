// European identifiers, ported from codemap-search `src/redact/pii/validators/europe.rs`.
import {
    byteLength,
    calendarDate,
    clean,
    digits,
    isAscii,
    isAsciiAlphabeticCode,
    isAsciiDigitCode,
    isAsciiUppercaseCode,
    isLuhnValid,
    mod11Of10,
    number,
    parseUnsigned,
    toAsciiUppercase,
    utf8Bytes,
} from "./checksums.js";

const USIZE_MAX = 18_446_744_073_709_551_615n;

export function isFinnishIdValid(value: string): boolean {
    if (value.length !== 11 || !isAscii(value)) return false;
    const marker = value[6] ?? "";
    const century =
        marker === "+" ? 1800 : "-YXWVU".includes(marker) ? 1900 : 2000;
    if (
        calendarDate(
            century + number(value.slice(4, 6)),
            number(value.slice(2, 4)),
            number(value.slice(0, 2)),
        ) === undefined
    )
        return false;
    const parsed = parseUnsigned(
        value.slice(0, 6) + value.slice(7, 10),
        USIZE_MAX,
    );
    if (parsed === undefined) return false;
    return (
        "0123456789ABCDEFHJKLMNPRSTUVWXY"[Number(parsed % 31n)] ===
        toAsciiUppercase(value[10] ?? "")
    );
}

function sumOfDigitProducts(
    numbers: readonly number[],
    weights: readonly number[],
): number {
    let sum = 0;
    const length = Math.min(numbers.length, weights.length);
    for (let index = 0; index < length; index++) {
        const product = (numbers[index] ?? 0) * (weights[index] ?? 0);
        sum += Math.floor(product / 10) + (product % 10);
    }
    return sum;
}

export function isGermanHealthIdValid(raw: string): boolean {
    const value = toAsciiUppercase(raw);
    const bytes = utf8Bytes(value);
    if (
        bytes.length !== 10 ||
        !isAsciiUppercaseCode(bytes[0]) ||
        !bytes.subarray(1).every((byte) => isAsciiDigitCode(byte))
    )
        return false;
    const letter = String((bytes[0] ?? 0) - 0x41 + 1).padStart(2, "0");
    const numbers = digits(letter + value.slice(1, 9));
    return (
        sumOfDigitProducts(numbers, [1, 2, 1, 2, 1, 2, 1, 2, 1, 2]) % 10 ===
        (bytes[9] ?? 0) - 0x30
    );
}

export function validateGermanDocument(
    raw: string,
    isIdentityCard: boolean,
): boolean | undefined {
    const bytes = utf8Bytes(toAsciiUppercase(raw));
    if (bytes.length !== 9 || !isAsciiDigitCode(bytes[8])) return false;
    if (
        isIdentityCard &&
        bytes[0] === 0x54 &&
        bytes.subarray(1).every((byte) => isAsciiDigitCode(byte))
    )
        return undefined;
    const excluded = [..."ABDEIOQSU"].map((character) =>
        character.charCodeAt(0),
    );
    if (
        !isIdentityCard &&
        bytes.subarray(0, 8).some((byte) => excluded.includes(byte))
    )
        return false;
    let sum = 0;
    for (let index = 0; index < 8; index++) {
        const byte = bytes[index] ?? 0;
        let digit: number;
        if (isAsciiDigitCode(byte)) digit = byte - 0x30;
        else if (isAsciiUppercaseCode(byte)) digit = byte - 0x41 + 10;
        else return false;
        sum += digit * ([7, 3, 1][index % 3] ?? 0);
    }
    return sum % 10 === (bytes[8] ?? 0) - 0x30;
}

export function isGermanSocialIdValid(raw: string): boolean {
    const value = toAsciiUppercase(raw);
    if (
        value.length !== 12 ||
        !isAscii(value) ||
        !isAsciiUppercaseCode(value.charCodeAt(8))
    )
        return false;
    const day = number(value.slice(2, 4));
    const month = number(value.slice(4, 6));
    if (
        !((day >= 1 && day <= 31) || (day >= 51 && day <= 81)) ||
        month < 1 ||
        month > 12
    )
        return false;
    const letter = String(value.charCodeAt(8) - 0x41 + 1).padStart(2, "0");
    const numbers = digits(value.slice(0, 8) + letter + value.slice(9, 11));
    return (
        numbers.length === 12 &&
        sumOfDigitProducts(numbers, [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1]) %
            10 ===
            number(value.slice(11))
    );
}

export function isGermanTaxIdValid(value: string): boolean {
    const numbers = digits(value);
    if (numbers.length !== 11 || numbers[0] === 0) return false;
    const counts = new Array<number>(10).fill(0);
    for (const digit of numbers.slice(0, 10))
        counts[digit] = (counts[digit] ?? 0) + 1;
    return (
        counts.every((count) => count <= 3) &&
        mod11Of10(numbers.slice(0, 10)) === numbers[10]
    );
}

export function validateGermanVat(raw: string): boolean | undefined {
    const value = clean(raw);
    if (byteLength(value) !== 11 || !value.startsWith("DE")) return false;
    const numbers = digits(value.slice(2));
    if (numbers.length !== 9) return false;
    // Upstream's default strict_checksum=false keeps an unverified candidate.
    return mod11Of10(numbers.slice(0, 8)) === numbers[8] ? true : undefined;
}

const ITALIAN_ODD_VALUES = [
    1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16,
    10, 22, 25, 24, 23,
];

export function validateItalianFiscalCode(raw: string): boolean | undefined {
    const value = toAsciiUppercase(raw);
    if (value.length !== 16 || !isAscii(value)) return false;
    let sum = 0;
    for (let index = 0; index < 15; index++) {
        const code = value.charCodeAt(index);
        let digit: number;
        if (isAsciiDigitCode(code)) digit = code - 0x30;
        else if (isAsciiUppercaseCode(code)) digit = code - 0x41;
        else return false;
        sum += index % 2 === 0 ? (ITALIAN_ODD_VALUES[digit] ?? 0) : digit;
    }
    // A checksum mismatch is not invalidated by the upstream recognizer.
    return String.fromCharCode(0x41 + (sum % 26)) === value[15]
        ? true
        : undefined;
}

const U64_MAX = 18_446_744_073_709_551_615n;

export function isSpanishIdValid(raw: string, isForeigner: boolean): boolean {
    const value = clean(raw);
    if (value === "" || !isAscii(value)) return false;
    let body: string;
    if (isForeigner) {
        if (value.length < 8 || value.length > 9) return false;
        const prefix = "XYZ".indexOf(value[0] ?? "");
        if (prefix === -1) return false;
        body = `${prefix}${value.slice(1, -1)}`;
    } else body = value.slice(0, -1);
    const parsed = parseUnsigned(body, U64_MAX);
    if (parsed === undefined) return false;
    return "TRWAGMYFPDXBNJZSQVHLCKE"[Number(parsed % 23n)] === value.at(-1);
}

export function isSwedishIdValid(
    raw: string,
    isOrganization: boolean,
): boolean {
    const allDigits = [...raw]
        .filter((character) => /^[0-9]$/.test(character))
        .join("");
    const value = isOrganization
        ? allDigits
        : allDigits.slice(Math.max(allDigits.length - 10, 0));
    if (value.length !== 10) return false;
    if (isOrganization) {
        if (value.charCodeAt(2) < 0x32) return false;
    } else {
        let day = number(value.slice(4, 6));
        if (day >= 61) day -= 60;
        const month = number(value.slice(2, 4));
        if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    }
    return isLuhnValid(value);
}

export function validateUkDriverLicense(value: string): boolean | undefined {
    const bytes = utf8Bytes(value);
    if (bytes.length < 5) return false;
    // `value.get(..5)` fails when byte 5 splits a character.
    const fifth = bytes[5];
    if (fifth !== undefined && (fifth & 0xc0) === 0x80) return false;
    const surname = new TextDecoder().decode(bytes.subarray(0, 5));
    const letters = surname.replace(/9+$/, "");
    if (
        letters === "" ||
        ![...letters].every((character) =>
            isAsciiAlphabeticCode(character.charCodeAt(0)),
        )
    )
        return false;
    return undefined;
}

export function validateUkVehicleRegistration(
    raw: string,
): boolean | undefined {
    const value = clean(raw);
    if (
        byteLength(value) === 7 &&
        isAsciiAlphabeticCode(value.charCodeAt(0)) &&
        isAsciiAlphabeticCode(value.charCodeAt(1))
    ) {
        const age = parseUnsigned(
            new TextDecoder().decode(utf8Bytes(value).subarray(2, 4)),
            4_294_967_295n,
        );
        if (age !== undefined) {
            const years = Number(age);
            return (years >= 2 && years <= 29) || (years >= 51 && years <= 79);
        }
    }
    return undefined;
}
