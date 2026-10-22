/**
 * Host-independent API shared by the CLI and Pi. Version 2 returns Effect values instead of promises;
 * version 3 takes the HTTP transport and device identity collection from services instead of options.
 */
export const CORE_CONTRACT_VERSION = 3;
export * from "./types.ts";
export * from "./errors.ts";
export * from "./cancellation.ts";
export * from "./validation.ts";
export * from "./redaction.ts";
export * from "./client.ts";
export * from "./auth/index.ts";
export * from "./models/catalog.ts";
export * from "./inference/request.ts";
export * from "./inference/accumulator.ts";
export * from "./inference/stream-chat.ts";
export * from "./inference/messages.ts";
export * from "./inference/retry.ts";
export * from "./inference/state.ts";
export * from "./protocol/connect-client.ts";
export * from "./protocol/frames.ts";
export * from "./protocol/endpoint.ts";
export * from "./protocol/fingerprint.ts";
export * from "./services/http-transport.ts";
export * from "./services/device-identity.ts";
export * from "./services/platform.ts";
