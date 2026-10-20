// Candidate validation only, ported from codemap-search `src/redact/pii/validators/mod.rs`.
// `undefined` keeps Presidio's unverified-match semantics and is deliberately
// distinct from a rejected candidate (`false`).
import {
    isCompanyRegistrationValid,
    isLicencePlateValid,
    isSouthAfricanIdValid,
} from "./africa.js";
import {
    type AsiaValidationData,
    isGstinValid,
    isKoreanBusinessNumberValid,
    isKoreanDriverLicenseValid,
    isSingaporeUenValid,
    isTurkishIdValid,
    validateIndiaVehicleRegistration,
    validateKoreanRegistration,
} from "./asia.js";
import {
    byteLength,
    clean,
    digits,
    isAscii,
    isAsciiAlphabeticCode,
    isLuhnValid,
    isVerhoeffValid,
    normalizeNumerals,
    number,
    utf8Bytes,
    weighted,
} from "./checksums.js";
import { isCryptoValid } from "./crypto.js";
import {
    isFinnishIdValid,
    isGermanHealthIdValid,
    isGermanSocialIdValid,
    isGermanTaxIdValid,
    isSpanishIdValid,
    isSwedishIdValid,
    validateGermanDocument,
    validateGermanVat,
    validateItalianFiscalCode,
    validateUkDriverLicense,
    validateUkVehicleRegistration,
} from "./europe.js";
import {
    hasExactIbanLength,
    type IbanFormats,
    isEmailValid,
    isIbanValid,
    isIpValid,
    isMacValid,
    isUuidValid,
} from "./international.js";

export interface ValidationData {
    readonly ibanFormats: IbanFormats;
    readonly asia: AsiaValidationData;
}

export interface CandidateValidator {
    isAccepted(validator: string, value: string): boolean;
    hasExactIbanLength(value: string): boolean;
}

function isSsnValid(raw: string): boolean {
    const value = clean(raw);
    if (value.length !== 9 || !/^[0-9]{9}$/.test(value)) return false;
    const delimiterCount = [".", "-", " "].filter((delimiter) =>
        raw.includes(delimiter),
    ).length;
    return (
        delimiterCount <= 1 &&
        ![...value].every((character) => character === value[0]) &&
        !["000", "666"].includes(value.slice(0, 3)) &&
        value.slice(3, 5) !== "00" &&
        value.slice(5) !== "0000" &&
        !["123456789", "987654320", "078051120"].includes(value)
    );
}

function evaluate(
    data: ValidationData,
    validator: string,
    raw: string,
): boolean | undefined {
    const value = clean(raw);
    const numbers = digits(value);
    const length = byteLength(value);
    const isNumeric = length === numbers.length;
    const at = (index: number) => numbers[index] ?? 0;
    switch (validator) {
        case "":
            return undefined;
        case "CreditCardRecognizer":
            return isLuhnValid(value);
        case "CryptoRecognizer":
            return isCryptoValid(raw);
        case "EmailRecognizer":
            return isEmailValid(raw);
        case "IbanRecognizer":
            return isIbanValid(data.ibanFormats, raw);
        case "IpRecognizer":
            return isIpValid(raw);
        case "MacAddressRecognizer":
            return isMacValid(raw);
        case "UuidRecognizer":
            return isUuidValid(raw);
        case "AuAbnRecognizer":
            return (
                numbers.length === 11 &&
                isNumeric &&
                (((weighted(numbers, [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]) -
                    10) %
                    89) +
                    89) %
                    89 ===
                    0
            );
        case "AuAcnRecognizer":
            return (
                numbers.length === 9 &&
                isNumeric &&
                (10 -
                    (weighted(numbers.slice(0, 8), [8, 7, 6, 5, 4, 3, 2, 1]) %
                        10)) %
                    10 ===
                    at(8)
            );
        case "AuMedicareRecognizer":
            return (
                numbers.length === 10 &&
                isNumeric &&
                weighted(numbers.slice(0, 8), [1, 3, 7, 9, 1, 3, 7, 9]) % 10 ===
                    at(8)
            );
        case "AuTfnRecognizer":
            return (
                numbers.length === 9 &&
                isNumeric &&
                weighted(numbers, [1, 4, 3, 7, 5, 8, 6, 9, 10]) % 11 === 0
            );
        case "CaSinRecognizer":
            return (
                !(raw.includes("-") && raw.includes(" ")) && isLuhnValid(value)
            );
        case "FiPersonalIdentityCodeRecognizer":
            return isFinnishIdValid(raw);
        case "DeBsnrRecognizer":
            return numbers.length === 9 && isNumeric && value !== "000000000"
                ? undefined
                : false;
        case "DeHealthInsuranceRecognizer":
            return isGermanHealthIdValid(raw);
        case "DeIdCardRecognizer":
            return validateGermanDocument(raw, true);
        case "DePassportRecognizer":
            return validateGermanDocument(raw, false);
        case "DeLanrRecognizer":
            return (
                numbers.length === 9 &&
                isNumeric &&
                (10 -
                    (weighted(numbers.slice(0, 6), [4, 9, 4, 9, 4, 9]) % 10)) %
                    10 ===
                    at(6)
            );
        case "DeSocialSecurityRecognizer":
            return isGermanSocialIdValid(raw);
        case "DeTaxIdRecognizer":
            return isGermanTaxIdValid(raw);
        case "DeVatIdRecognizer":
            return validateGermanVat(raw);
        case "InAadhaarRecognizer":
            return (
                numbers.length === 12 &&
                isNumeric &&
                at(0) >= 2 &&
                value !== [...value].reverse().join("") &&
                isVerhoeffValid(value)
            );
        case "InGstinRecognizer":
            return isGstinValid(raw);
        case "InVehicleRegistrationRecognizer":
            return validateIndiaVehicleRegistration(data.asia, raw);
        case "ItFiscalCodeRecognizer":
            return validateItalianFiscalCode(raw);
        case "ItVatCodeRecognizer":
            return (
                length === 11 && value !== "00000000000" && isLuhnValid(value)
            );
        case "KrBrnRecognizer":
            return isKoreanBusinessNumberValid(raw);
        case "KrDriverLicenseRecognizer":
            return isKoreanDriverLicenseValid(data.asia, raw);
        case "KrRrnRecognizer":
            return validateKoreanRegistration(raw, false);
        case "KrFrnRecognizer":
            return validateKoreanRegistration(raw, true);
        case "NgNinRecognizer":
            return numbers.length === 11 && isNumeric && isVerhoeffValid(value);
        case "PhTinRecognizer":
            return (
                (numbers.length === 9 || numbers.length === 12) &&
                isNumeric &&
                weighted(numbers.slice(0, 8), [9, 8, 7, 6, 5, 4, 3, 2]) % 11 ===
                    at(8)
            );
        case "PlPeselRecognizer":
            return (
                numbers.length === 11 &&
                isNumeric &&
                (10 -
                    (weighted(
                        numbers.slice(0, 10),
                        [1, 3, 7, 9, 1, 3, 7, 9, 1, 3],
                    ) %
                        10)) %
                    10 ===
                    at(10)
            );
        case "SgUenRecognizer":
            return isSingaporeUenValid(data.asia, raw);
        case "EsNieRecognizer":
            return isSpanishIdValid(raw, true);
        case "EsNifRecognizer":
            return isSpanishIdValid(raw, false);
        case "SeOrganisationsnummerRecognizer":
            return isSwedishIdValid(raw, true);
        case "SePersonnummerRecognizer":
            return isSwedishIdValid(raw, false);
        case "ThTninRecognizer":
            return (
                numbers.length === 13 &&
                isNumeric &&
                (11 -
                    (weighted(
                        numbers.slice(0, 12),
                        [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
                    ) %
                        11)) %
                    10 ===
                    at(12)
            );
        case "TrLicensePlateRecognizer": {
            // `value.get(..2)` fails on fewer than two bytes or a split character.
            const bytes = utf8Bytes(value);
            const third = bytes[2];
            if (
                bytes.length < 2 ||
                (third !== undefined && (third & 0xc0) === 0x80)
            )
                return undefined;
            const prefix = number(
                new TextDecoder().decode(bytes.subarray(0, 2)),
            );
            return prefix >= 1 && prefix <= 81;
        }
        case "TrNationalIdRecognizer":
            return isTurkishIdValid(raw);
        case "UkDrivingLicenceRecognizer":
            return validateUkDriverLicense(raw);
        case "UkVehicleRegistrationRecognizer":
            return validateUkVehicleRegistration(raw);
        case "NhsRecognizer":
            return (
                numbers.length === 10 &&
                isNumeric &&
                weighted(numbers, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0
            );
        case "AbaRoutingRecognizer":
            return (
                numbers.length === 9 &&
                isNumeric &&
                weighted(numbers, [3, 7, 1, 3, 7, 1, 3, 7, 1]) % 10 === 0
            );
        case "MedicalLicenseRecognizer": {
            if (length !== 9) return false;
            const tail = digits(value.slice(2));
            return (
                tail.length === 7 &&
                weighted(tail.slice(0, 6), [1, 2, 1, 2, 1, 2]) % 10 === tail[6]
            );
        }
        case "UsNpiRecognizer":
            return (
                numbers.length === 10 &&
                isNumeric &&
                !numbers.slice(0, 9).every((digit) => digit === at(0)) &&
                isLuhnValid(`80840${value}`)
            );
        case "UsSsnRecognizer":
            return isSsnValid(raw);
        case "ZaCompanyRegistrationRecognizer":
            return isCompanyRegistrationValid(raw);
        case "ZaDriverLicenseRecognizer":
            return (
                length >= 8 &&
                length <= 15 &&
                [...value].some((character) =>
                    isAsciiAlphabeticCode(character.charCodeAt(0)),
                )
            );
        case "ZaIdNumberRecognizer":
            return isSouthAfricanIdValid(raw);
        case "ZaIncomeTaxNumberRecognizer":
            return (
                length === 10 && isNumeric && "01239".includes(value[0] ?? "")
            );
        case "ZaLicensePlateRecognizer":
            return isLicencePlateValid(raw);
        case "ZaPassportRecognizer":
            return (
                length === 9 &&
                isAscii(value) &&
                "ADMT".includes(value[0] ?? "") &&
                /^.[0-9]{8}$/.test(value)
            );
        case "ZaTrafficRegisterNumberRecognizer":
            return length === 13 && isNumeric && !isSouthAfricanIdValid(raw);
        case "ZaVatNumberRecognizer":
            return length === 10 && isNumeric && value.startsWith("4");
        default:
            throw new Error("Unknown PII validator");
    }
}

export function createCandidateValidator(
    data: ValidationData,
): CandidateValidator {
    return {
        isAccepted: (validator, value) =>
            evaluate(data, validator, normalizeNumerals(value)) !== false,
        hasExactIbanLength: (value) =>
            hasExactIbanLength(data.ibanFormats, value),
    };
}
