import { gunzipSync } from "node:zlib";
import { Effect, Stream } from "effect";
import { DevinError } from "../errors.ts";
import type { JsonObject } from "../types.ts";
import { failWith, object } from "../validation.ts";
import { chatResponseCodec } from "./protobuf.ts";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface Frame {
  isEnd: boolean;
  data: JsonObject;
}

export function encodeFrame(bytes: Uint8Array, flags = 0): Effect.Effect<Buffer, DevinError> {
  return Effect.suspend(() => {
    const payload = Buffer.from(bytes);
    if (payload.length > MAX_FRAME_BYTES) return failWith("The request frame exceeds 8 MiB.");
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(payload.length, 1);
    return Effect.succeed(Buffer.concat([header, payload]));
  });
}

/** The connection ended before the stream was complete, so a new request may succeed. */
const prematureClose = (message: string) => new DevinError({ message, code: "ERR_STREAM_PREMATURE_CLOSE" });

/** Parses one response's Connect envelopes. HTTP chunk boundaries and Connect frame boundaries are independent. */
class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);
  private hasEnded = false;
  private wireBytes = 0;
  private decodedBytes = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly compression: "identity" | "gzip" | undefined;

  constructor(compression: "identity" | "gzip" | undefined) {
    this.compression = compression;
  }

  push(chunk: Uint8Array): Effect.Effect<Frame[], DevinError> {
    const self = this;
    return Effect.gen(function* () {
      self.wireBytes += chunk.byteLength;
      if (self.wireBytes > MAX_RESPONSE_BYTES) return yield* failWith("The response exceeds 64 MiB.");
      if (self.hasEnded && chunk.byteLength > 0) return yield* failWith("Data follows EndStream.");
      self.buffered = Buffer.concat([self.buffered, chunk]);
      const frames: Frame[] = [];
      while (self.buffered.length >= 5) {
        if (self.hasEnded) return yield* failWith("A frame follows EndStream.");
        const flags = self.buffered[0];
        if ((flags & ~3) !== 0) return yield* failWith(`Unknown Connect flags: ${flags}`);
        const payloadBytes = self.buffered.readUInt32BE(1);
        if (payloadBytes > MAX_FRAME_BYTES) return yield* failWith("The response frame exceeds 8 MiB.");
        if (self.buffered.length < 5 + payloadBytes) break;
        let payload: Buffer = self.buffered.subarray(5, 5 + payloadBytes);
        self.buffered = self.buffered.subarray(5 + payloadBytes);
        if (flags & 1) {
          if (self.compression !== "gzip") return yield* failWith("A compressed frame has no valid gzip encoding header.");
          const compressed = payload;
          payload = yield* Effect.try({
            try: () => gunzipSync(compressed, { maxOutputLength: MAX_FRAME_BYTES }),
            catch: () => new DevinError({ message: "The gzip frame is corrupt or exceeds the decompression limit." }),
          });
        }
        self.decodedBytes += payload.byteLength;
        if (self.decodedBytes > MAX_RESPONSE_BYTES) return yield* failWith("The decompressed response exceeds 64 MiB.");
        self.hasEnded = Boolean(flags & 2);
        const bytes = payload;
        const data = self.hasEnded
          ? yield* Effect.try({ try: () => JSON.parse(self.decoder.decode(bytes)) as unknown, catch: () => undefined }).pipe(
            Effect.flatMap((value) => object(value, "EndStream")),
            Effect.mapError(() => new DevinError({ message: "EndStream is not a valid UTF-8 JSON object." })),
          )
          : yield* chatResponseCodec.decode(bytes);
        frames.push({ isEnd: self.hasEnded, data });
      }
      return frames;
    });
  }

  get end(): Effect.Effect<void, DevinError> {
    if (this.buffered.length !== 0) return Effect.fail(prematureClose("The connection ended with an incomplete Connect frame."));
    if (!this.hasEnded) return Effect.fail(prematureClose("The connection ended without EndStream."));
    return Effect.void;
  }
}

/** Decodes Connect frames from a response body. A truncated stream fails as a premature close. */
export function decodeFrames<E, R>(chunks: Stream.Stream<Uint8Array, E, R>, options: { compression?: "identity" | "gzip" } = {}): Stream.Stream<Frame, E | DevinError, R> {
  return Stream.suspend(() => {
    const decoder = new FrameDecoder(options.compression);
    return chunks.pipe(
      Stream.mapEffect((chunk) => decoder.push(chunk)),
      Stream.flattenIterable,
      Stream.concat(Stream.fromEffectDrain(Effect.suspend(() => decoder.end))),
    );
  });
}
