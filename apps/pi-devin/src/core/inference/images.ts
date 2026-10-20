import type { ImageData } from "../types.ts";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 5 * 1024 * 1024;

export function imageMimeType(bytes: Uint8Array): ImageData["mimeType"] {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("Unsupported image. Use a PNG, JPEG, GIF or WebP file.");
}

export function imageFromBase64(data: string, mimeType: string): { image: ImageData; sizeBytes: number } {
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error("Invalid image Base64 format or size.");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) throw new Error("Invalid image Base64 format or size.");
  const actualMimeType = imageMimeType(bytes);
  if (mimeType !== actualMimeType) throw new Error("The image MIME type does not match its actual format.");
  return { image: { base64Data: data, mimeType: actualMimeType }, sizeBytes: bytes.length };
}
