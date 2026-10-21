function base64Digit(code: number): number {
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 97 + 26;
    if (code >= 48 && code <= 57) return code - 48 + 52;
    if (code === 43) return 62;
    if (code === 47) return 63;
    return -1;
}

/** Nonempty standard base64 with required padding and zero pad bits (Codex BASE64_STANDARD). */
export function isValidImageBase64(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length % 4 !== 0) return false;
    const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
    const end = trimmed.length - padding;
    let last = 0;
    for (let index = 0; index < end; index++) {
        last = base64Digit(trimmed.charCodeAt(index));
        if (last === -1) return false;
    }
    // Unused bits in the final sextet must be zero, not just decodable by Buffer.
    return padding === 2
        ? (last & 15) === 0
        : padding === 1
          ? (last & 3) === 0
          : true;
}
