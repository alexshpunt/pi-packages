// Shared arithmetic and canonicalization for identifier validation, ported from
// codemap-search `src/redact/pii/validators/{checksums,numerals}.rs`. Rust
// `str::len()` counts UTF-8 bytes, so length checks go through `byteLength`.
import { isWhitespaceAt } from "../../unicode.js";

const DIGIT_BLOCK_STARTS = [
    0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66,
    0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810,
    0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620,
    0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30,
    0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0,
    0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0,
    0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50,
    0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140,
    0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
];

/** Decimal value of a Unicode decimal digit, using the source's fixed block table. */
export function decimalDigit(codePoint: number): number | undefined {
    let low = 0;
    let high = DIGIT_BLOCK_STARTS.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if ((DIGIT_BLOCK_STARTS[middle] ?? 0) <= codePoint) low = middle + 1;
        else high = middle;
    }
    if (low === 0) return undefined;
    const distance = codePoint - (DIGIT_BLOCK_STARTS[low - 1] ?? 0);
    return distance < 10 ? distance : undefined;
}

/** Map Unicode decimal digits to ASCII for validation only; ranges keep original text. */
export function normalizeNumerals(value: string): string {
    if (isAscii(value)) return value;
    let output = "";
    for (const character of value) {
        const digit = decimalDigit(character.codePointAt(0) ?? 0);
        output += digit === undefined ? character : String(digit);
    }
    return output;
}

export function isAscii(value: string): boolean {
    for (let index = 0; index < value.length; index++)
        if (value.charCodeAt(index) > 0x7f) return false;
    return true;
}

export function byteLength(value: string): number {
    let length = 0;
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        length +=
            codePoint < 0x80
                ? 1
                : codePoint < 0x800
                  ? 2
                  : codePoint < 0x10000
                    ? 3
                    : 4;
    }
    return length;
}

export function utf8Bytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

export function isAsciiDigitCode(code: number | undefined): boolean {
    return code !== undefined && code >= 0x30 && code <= 0x39;
}

export function isAsciiUppercaseCode(code: number | undefined): boolean {
    return code !== undefined && code >= 0x41 && code <= 0x5a;
}

export function isAsciiAlphabeticCode(code: number | undefined): boolean {
    return (
        code !== undefined &&
        ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
    );
}

export function isAsciiAlphanumericCode(code: number | undefined): boolean {
    return isAsciiAlphabeticCode(code) || isAsciiDigitCode(code);
}

/** Rust `char::to_ascii_uppercase` applied to a string. */
export function toAsciiUppercase(value: string): string {
    return value.replace(/[a-z]+/g, (letters) => letters.toUpperCase());
}

/** Remove whitespace and `-_:.`, then uppercase per code point. */
export function clean(value: string): string {
    let output = "";
    for (const character of value) {
        if (isWhitespaceAt(character, 0) || "-_:.".includes(character))
            continue;
        output += character.toUpperCase();
    }
    return output;
}

/** ASCII digits only, like Rust `char::to_digit(10)`. */
export function digits(value: string): number[] {
    const numbers: number[] = [];
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (isAsciiDigitCode(code)) numbers.push(code - 0x30);
    }
    return numbers;
}

export function weighted(
    numbers: readonly number[],
    weights: readonly number[],
): number {
    let sum = 0;
    const length = Math.min(numbers.length, weights.length);
    for (let index = 0; index < length; index++)
        sum += (numbers[index] ?? 0) * (weights[index] ?? 0);
    return sum;
}

const U32_MAX = 4_294_967_295;

/** Rust `str::parse` for an unsigned integer: optional `+`, ASCII digits, no overflow. */
export function parseUnsigned(
    value: string,
    maximum: bigint,
): bigint | undefined {
    if (!/^\+?[0-9]+$/.test(value)) return undefined;
    const parsed = BigInt(value.startsWith("+") ? value.slice(1) : value);
    return parsed <= maximum ? parsed : undefined;
}

/** `value.parse::<u32>()`, or `u32::MAX` when it fails, like the source `number()`. */
export function number(value: string): number {
    const parsed = parseUnsigned(value, BigInt(U32_MAX));
    return parsed === undefined ? U32_MAX : Number(parsed);
}

export function isLuhnValid(value: string): boolean {
    if (value === "" || !/^[0-9]+$/.test(value)) return false;
    let sum = 0;
    for (let index = 0; index < value.length; index++) {
        const digit = value.charCodeAt(value.length - 1 - index) - 0x30;
        const product = digit * (index % 2 === 1 ? 2 : 1);
        sum += product > 9 ? product - 9 : product;
    }
    return sum % 10 === 0;
}

export function mod11Of10(numbers: readonly number[]): number {
    const product = numbers.reduce((current, digit) => {
        const sum = (current + digit) % 10;
        return ((sum === 0 ? 10 : sum) * 2) % 11;
    }, 10);
    return (11 - product) % 10;
}

const VERHOEFF_MULTIPLICATION = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_PERMUTATION = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function isVerhoeffValid(value: string): boolean {
    if (value === "" || !/^[0-9]+$/.test(value)) return false;
    let check = 0;
    for (let index = 0; index < value.length; index++) {
        const digit = value.charCodeAt(value.length - 1 - index) - 0x30;
        check =
            VERHOEFF_MULTIPLICATION[check]?.[
                VERHOEFF_PERMUTATION[index % 8]?.[digit] ?? 0
            ] ?? 0;
    }
    return check === 0;
}

/** A valid proleptic Gregorian date within the `time` crate's default ±9999 years. */
export function calendarDate(
    year: number,
    month: number,
    day: number,
): Date | undefined {
    if (
        year < -9999 ||
        year > 9999 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 255
    )
        return undefined;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
        ? date
        : undefined;
}

export function todayUtc(): Date {
    const now = new Date();
    return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
}
