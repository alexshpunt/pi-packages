// Bitcoin address checksums from Presidio's CryptoRecognizer, ported from
// codemap-search `src/redact/pii/validators/crypto.rs`.
import { createHash } from "node:crypto";
import { utf8Bytes } from "./checksums.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function sha256(bytes: Uint8Array): Uint8Array {
    return createHash("sha256").update(bytes).digest();
}

function decodeBase58(value: string): Uint8Array | undefined {
    const bytes: number[] = [];
    for (const byte of utf8Bytes(value)) {
        let carry = BASE58.indexOf(String.fromCharCode(byte));
        if (carry === -1 || byte >= 0x80) return undefined;
        for (let index = 0; index < bytes.length; index++) {
            carry += (bytes[index] ?? 0) * 58;
            bytes[index] = carry & 0xff;
            carry >>= 8;
        }
        while (carry !== 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    for (let index = 0; index < value.length && value[index] === "1"; index++)
        bytes.push(0);
    return Uint8Array.from(bytes.reverse());
}

function isBech32Valid(value: string): boolean {
    const bytes = utf8Bytes(value);
    const lowercase = value.replace(/[A-Z]+/g, (letters) =>
        letters.toLowerCase(),
    );
    const uppercase = value.replace(/[a-z]+/g, (letters) =>
        letters.toUpperCase(),
    );
    if (
        bytes.length > 90 ||
        !bytes.every((byte) => byte >= 33 && byte <= 126) ||
        (value !== lowercase && value !== uppercase)
    )
        return false;
    const separator = lowercase.lastIndexOf("1");
    if (separator === -1) return false;
    const prefix = lowercase.slice(0, separator);
    const data = lowercase.slice(separator + 1);
    if (prefix === "" || data.length < 6) return false;
    const values: number[] = [];
    for (const character of prefix) values.push(character.charCodeAt(0) >> 5);
    values.push(0);
    for (const character of prefix) values.push(character.charCodeAt(0) & 31);
    for (const character of data) {
        const position = BECH32.indexOf(character);
        if (position === -1) return false;
        values.push(position);
    }
    let check = 1;
    for (const value of values) {
        const top = check >>> 25;
        let next = (((check & 0x1ffffff) << 5) ^ value) >>> 0;
        for (let index = 0; index < GENERATORS.length; index++)
            if ((top >>> index) & 1)
                next = (next ^ (GENERATORS[index] ?? 0)) >>> 0;
        check = next;
    }
    return check === 1 || check === 0x2bc830a3;
}

export function isCryptoValid(value: string): boolean {
    if (value.startsWith("1") || value.startsWith("3")) {
        const decoded = decodeBase58(value);
        if (!decoded || decoded.length < 4) return false;
        const split = decoded.length - 4;
        const digest = sha256(sha256(decoded.subarray(0, split)));
        return decoded
            .subarray(split)
            .every((byte, index) => byte === digest[index]);
    }
    if (value.startsWith("bc1")) return isBech32Valid(value);
    return false;
}
