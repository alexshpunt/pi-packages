// Indian, Korean, Singaporean, and Turkish identifiers, ported from
// codemap-search `src/redact/pii/validators/asia.rs`.
import {
    byteLength,
    clean,
    digits,
    isAscii,
    isAsciiAlphabeticCode,
    isAsciiAlphanumericCode,
    isAsciiDigitCode,
    number,
    toAsciiUppercase,
    weighted,
} from "./checksums.js";

export interface AsiaValidationData {
    readonly InVehicleRegistrationRecognizer: {
        readonly two_factor_registration_prefix: readonly string[];
        readonly state_rto_district_map: Readonly<
            Record<string, readonly string[]>
        >;
    };
    readonly KrDriverLicenseRecognizer: {
        readonly REGION_CODES: readonly string[];
    };
    readonly SgUenRecognizer: {
        readonly UEN_FORMAT_C_ENTITY_TYPE: readonly string[];
    };
}

export function isGstinValid(raw: string): boolean {
    const value = clean(raw);
    if (value.length !== 15 || !isAscii(value)) return false;
    const code = (index: number) => value.charCodeAt(index);
    const prefix = number(value.slice(0, 2));
    let letters = 0;
    for (let index = 2; index < 7; index++)
        if (isAsciiAlphabeticCode(code(index))) letters++;
    return (
        prefix >= 1 &&
        prefix <= 37 &&
        letters >= 3 &&
        /^[0-9]{4}$/.test(value.slice(7, 11)) &&
        isAsciiAlphabeticCode(code(11)) &&
        isAsciiAlphanumericCode(code(12)) &&
        value[13] === "Z" &&
        isAsciiAlphanumericCode(code(14))
    );
}

export function validateIndiaVehicleRegistration(
    data: AsiaValidationData,
    raw: string,
): boolean | undefined {
    const value = clean(raw);
    if (value.length < 8 || !isAscii(value)) return undefined;
    const profile = data.InVehicleRegistrationRecognizer;
    const prefix = value.slice(0, 2);
    if (!profile.two_factor_registration_prefix.includes(prefix))
        return undefined;
    if (isAsciiDigitCode(value.charCodeAt(2))) {
        const district = isAsciiDigitCode(value.charCodeAt(3))
            ? value.slice(2, 4)
            : value.slice(2, 3);
        const serial = number(value.slice(-4));
        const districts = profile.state_rto_district_map[prefix];
        const unpadded = String(number(district));
        if (
            serial >= 1 &&
            serial <= 9999 &&
            Array.isArray(districts) &&
            districts.some((entry) => entry === district || entry === unpadded)
        )
            return true;
    }
    // Upstream retains other matching formats as unverified, rather than rejecting them.
    return undefined;
}

export function validateKoreanRegistration(
    raw: string,
    isForeigner: boolean,
): boolean | undefined {
    const value = clean(raw);
    const numbers = digits(value);
    if (numbers.length !== 13 || byteLength(value) !== 13) return false;
    const sum = weighted(
        numbers.slice(0, 12),
        [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5],
    );
    const modulus = isForeigner ? 13 : 11;
    const isValid =
        number(value.slice(7, 9)) <= 95 &&
        (modulus - (sum % 11)) % 10 === numbers[12];
    // Newer registrations use random suffixes: failed legacy checksums stay candidates.
    return isValid ? true : undefined;
}

export function isKoreanBusinessNumberValid(value: string): boolean {
    const numbers = digits(value);
    if (numbers.length !== 10) return false;
    const last = (numbers[8] ?? 0) * 5;
    const sum =
        weighted(numbers.slice(0, 8), [1, 3, 7, 1, 3, 7, 1, 3]) +
        last +
        Math.floor(last / 10);
    return (10 - (sum % 10)) % 10 === numbers[9];
}

export function isKoreanDriverLicenseValid(
    data: AsiaValidationData,
    raw: string,
): boolean {
    const value = clean(raw);
    return (
        /^[0-9]{12}$/.test(value) &&
        data.KrDriverLicenseRecognizer.REGION_CODES.includes(value.slice(0, 2))
    );
}

export function isSingaporeUenValid(
    data: AsiaValidationData,
    raw: string,
): boolean {
    const value = toAsciiUppercase(raw);
    if (!isAscii(value) || (value.length !== 9 && value.length !== 10))
        return false;
    const body = value.slice(0, -1);
    const check = value.at(-1);
    if (value.length === 9) {
        const numbers = digits(body);
        return (
            numbers.length === 8 &&
            "XMKECAWLJDB"[weighted(numbers, [10, 4, 9, 3, 8, 2, 7, 1]) % 11] ===
                check
        );
    }
    if (isAsciiDigitCode(value.charCodeAt(0))) {
        if (number(value.slice(0, 4)) > new Date().getUTCFullYear())
            return false;
        const numbers = digits(body);
        return (
            numbers.length === 9 &&
            "ZKCMDNERGWH"[
                weighted(numbers, [10, 8, 6, 4, 9, 7, 5, 3, 1]) % 11
            ] === check
        );
    }
    if (
        !"TSR".includes(value[0] ?? "") ||
        !data.SgUenRecognizer.UEN_FORMAT_C_ENTITY_TYPE.includes(
            value.slice(3, 5),
        )
    )
        return false;
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWX0123456789";
    const numbers: number[] = [];
    for (const character of body) {
        const position = alphabet.indexOf(character);
        if (position === -1) return false;
        numbers.push(position);
    }
    const sum = weighted(numbers, [4, 3, 5, 3, 10, 2, 2, 5, 7]) - 5;
    return alphabet[((sum % 11) + 11) % 11] === check;
}

export function isTurkishIdValid(value: string): boolean {
    const numbers = digits(value);
    if (numbers.length !== 11 || numbers[0] === 0) return false;
    const at = (index: number) => numbers[index] ?? 0;
    const odd = at(0) + at(2) + at(4) + at(6) + at(8);
    const even = at(1) + at(3) + at(5) + at(7);
    const total = numbers.slice(0, 10).reduce((sum, digit) => sum + digit, 0);
    return (
        (((odd * 7 - even) % 10) + 10) % 10 === at(9) && total % 10 === at(10)
    );
}
