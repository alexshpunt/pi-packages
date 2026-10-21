import { StringDecoder } from "node:string_decoder";

export const MAX_ERROR_TEXT_BYTES = 4 * 1024;
const TRUNCATION_NOTICE = "\n[Error text truncated.]";

/** Bounds the complete diagnostic, including its notice, without splitting UTF-8. */
export function boundErrorText(message: string): string {
    if (Buffer.byteLength(message, "utf8") <= MAX_ERROR_TEXT_BYTES) {
        return message;
    }
    const prefix = Buffer.from(message.slice(0, MAX_ERROR_TEXT_BYTES), "utf8");
    const budget = MAX_ERROR_TEXT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE);
    return (
        new StringDecoder("utf8").write(prefix.subarray(0, budget)) +
        TRUNCATION_NOTICE
    );
}
