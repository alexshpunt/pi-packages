import { createHash } from "node:crypto";
import { Effect, Predicate, type Scope } from "effect";
import type { DevinError, DevinFailure } from "./errors.ts";
import { wireMessages } from "./inference/messages.ts";
import { parseModelCatalog, type ModelCatalog } from "./models/catalog.ts";
import { ASSIGN_MODEL_METHOD, makeConnectClient, type ConnectClient, type ConnectClientOptions } from "./protocol/connect-client.ts";
import { endpoint, isLoopbackHost } from "./protocol/endpoint.ts";
import { makeFingerprintProvider, type FingerprintProvider } from "./protocol/fingerprint.ts";
import { DeviceIdentitySource } from "./services/device-identity.ts";
import type { HttpTransport } from "./services/http-transport.ts";
import type { ChatMessage, Credential, JsonObject, ModelInfo } from "./types.ts";
import { failWith, object, requiredString } from "./validation.ts";

export const CLIENT_VERSION = "3000.11.92";
export type MetadataProfile = "agent" | "standalone" | "login";
const MODEL_DISPLAYS = [
  "DISPLAY_OPTION_MODEL_ROUTER", "DISPLAY_OPTION_QUICK_REVIEW", "DISPLAY_OPTION_HIDDEN_TOOL",
  "DISPLAY_OPTION_WIRE_7", "DISPLAY_OPTION_MODERN_AGENT_CHAT",
];
const STATUS_METHOD = "exa.seat_management_pb.SeatManagementService/GetUserStatus";
const MODELS_METHOD = "exa.api_server_pb.ApiServerService/GetCliModelConfigs";

export interface DevinClientOptions extends Omit<ConnectClientOptions, "baseURL" | "token"> {
  profile?: MetadataProfile;
  restBaseURL?: string;
  /** A provider shared with other clients of the same credential. Otherwise this client collects device values once for itself. */
  fingerprint?: FingerprintProvider;
}

export interface StatusOptions {
  /** Rejects a different signed-in user before anything else is sent. */
  expectedUserId?: string;
  profile?: MetadataProfile;
}

export interface DevinClient {
  readonly credential: Credential;
  readonly transport: ConnectClient;
  readonly profile: MetadataProfile;
  readonly fingerprint: FingerprintProvider;
  /** Default model of the last fetched catalog. */
  readonly defaultModelUid: Effect.Effect<string | undefined>;
  /** Hash of the endpoint and user ID from the last status check. */
  readonly accountIdentityHash: Effect.Effect<string | undefined>;
  readonly close: Effect.Effect<void>;
  metadata(options?: { profile?: MetadataProfile; includeModelDisplays?: boolean }): Effect.Effect<JsonObject, DevinError>;
  status(options?: StatusOptions): Effect.Effect<JsonObject, DevinFailure>;
  readonly catalog: Effect.Effect<ModelCatalog, DevinFailure>;
  readonly models: Effect.Effect<ModelInfo[], DevinFailure>;
  readonly teamSettings: Effect.Effect<JsonObject, DevinFailure>;
  readonly managedPlugins: Effect.Effect<JsonObject, DevinFailure>;
  assignModel(routerUid: string, cascadeId: string, message: ChatMessage | undefined): Effect.Effect<{ modelUid: string; assignmentJwt: string }, DevinFailure>;
  readonly self: Effect.Effect<JsonObject, DevinFailure>;
  readonly integrations: Effect.Effect<JsonObject | undefined, DevinFailure>;
  analytics(events: readonly JsonObject[]): Effect.Effect<void, DevinFailure>;
}

/** A client for one credential. It closes with the scope, or earlier through `close`. */
export function makeDevinClient(credential: Credential, options: DevinClientOptions = {}): Effect.Effect<DevinClient, DevinError, HttpTransport | DeviceIdentitySource | Scope.Scope> {
  return Effect.gen(function* () {
    const { profile = "agent", fingerprint: providedFingerprint, restBaseURL: explicitRestURL, ...transportOptions } = options;
    const rpcOrigin = yield* endpoint(credential.apiServerURL);
    const hasExplicitRestURL = explicitRestURL !== undefined;
    let restBaseURL = yield* endpoint(explicitRestURL ?? (isLoopbackHost(new URL(rpcOrigin).hostname) ? rpcOrigin : "https://api.devin.ai"));
    const device = yield* DeviceIdentitySource;
    const fingerprint = providedFingerprint ?? (yield* makeFingerprintProvider(credential.sessionToken, { collectIdentity: device.collect }));
    const transport = yield* makeConnectClient({ baseURL: credential.apiServerURL, token: credential.sessionToken, ...transportOptions });
    let defaultModelUid: string | undefined, accountIdentityHash: string | undefined, organizationId: string | undefined;

    const metadata: DevinClient["metadata"] = (metadataOptions = {}) => Effect.map(fingerprint.create, (f) => {
      const selected = metadataOptions.profile ?? profile;
      const version = selected === "standalone" ? "0.0.0-dev" : CLIENT_VERSION;
      return {
        apiKey: credential.sessionToken,
        ideName: selected === "agent" ? "devin-cli" : "chisel",
        ideVersion: version,
        extensionName: "chisel",
        extensionVersion: version,
        locale: "en",
        os: process.platform,
        ...(selected === "agent" ? { ideType: "chisel" } : {}),
        ...(metadataOptions.includeModelDisplays ? { supportedModelDisplays: [...MODEL_DISPLAYS] } : {}),
        f,
      };
    });

    const status: DevinClient["status"] = (statusOptions = {}) => Effect.gen(function* () {
      const response = yield* transport.unary(STATUS_METHOD, { metadata: yield* metadata({ profile: statusOptions.profile }) });
      const user = yield* object(response.userStatus, "userStatus");
      if (statusOptions.expectedUserId && user.userId !== statusOptions.expectedUserId) {
        return yield* failWith("The signed-in user ID differs from the requested account. Sign in again; no inference was run.");
      }
      const plan = yield* object(user.planStatus ?? {}, "planStatus");
      const info = yield* object(plan.planInfo ?? {}, "planInfo");
      const devin = yield* object(info.devinInfo ?? {}, "devinInfo");
      const userId = yield* requiredString(user.userId, "userStatus.userId");
      accountIdentityHash = createHash("sha256").update(`${transport.baseURL}\0${userId}`).digest("hex");
      organizationId = Predicate.isString(devin.orgId) ? devin.orgId : undefined;
      if (!hasExplicitRestURL && Predicate.isString(devin.apiUrl) && devin.apiUrl) {
        const candidate = yield* endpoint(devin.apiUrl);
        if (candidate !== restBaseURL && candidate !== transport.baseURL) return yield* failWith("Unverified REST server. Specify it explicitly with --rest-server.");
        restBaseURL = candidate;
      }
      const hasQuota = info.billingStrategy === "BILLING_STRATEGY_QUOTA";
      // Name, email, organization ID and the raw response are not exposed.
      return {
        ...(statusOptions.expectedUserId ? { identityVerified: true } : {}),
        teamsTier: user.teamsTier,
        canUseCli: info.devinInfo ? devin.canUseCli === true : undefined,
        billingStrategy: info.billingStrategy,
        dailyQuotaRemainingPercent: plan.dailyQuotaRemainingPercent ?? (hasQuota ? 0 : undefined),
        weeklyQuotaRemainingPercent: plan.weeklyQuotaRemainingPercent ?? (hasQuota ? 0 : undefined),
        dailyQuotaResetAtUnix: plan.dailyQuotaResetAtUnix,
        weeklyQuotaResetAtUnix: plan.weeklyQuotaResetAtUnix,
      };
    });

    const catalog = Effect.gen(function* () {
      const response = yield* transport.unary(MODELS_METHOD, { metadata: yield* metadata({ includeModelDisplays: true }) });
      const parsed = yield* parseModelCatalog(response);
      defaultModelUid = parsed.defaultModelUid;
      return parsed;
    });

    const assignModel: DevinClient["assignModel"] = (routerUid, cascadeId, message) => Effect.gen(function* () {
      const prompt = message ? wireMessages([message])[0] : undefined;
      if (prompt) delete prompt.promptCacheOptions;
      const response = yield* transport.unary(ASSIGN_MODEL_METHOD, {
        metadata: yield* metadata(), modelRouterUid: routerUid, cascadeId, ...(prompt ? { chatMessagePrompt: prompt } : {}),
      });
      const assignment = yield* object(response.assignment, "assignment");
      return {
        modelUid: yield* requiredString(assignment.modelUid, "assignment.modelUid"),
        assignmentJwt: message ? yield* requiredString(assignment.assignmentJwt, "assignment.assignmentJwt") : String(assignment.assignmentJwt ?? ""),
      };
    });

    return {
      credential, transport, profile, fingerprint, metadata, status, catalog, assignModel,
      close: transport.close,
      defaultModelUid: Effect.sync(() => defaultModelUid),
      accountIdentityHash: Effect.sync(() => accountIdentityHash),
      models: Effect.map(catalog, (parsed) => parsed.models),
      teamSettings: Effect.flatMap(metadata({ includeModelDisplays: true }), (value) =>
        transport.unary("exa.seat_management_pb.SeatManagementService/GetCliTeamSettings", { metadata: value })),
      // Only fetches the manifest. This does not mean installing a remote plugin or running its commands is approved.
      managedPlugins: Effect.flatMap(metadata(), (value) => transport.unary("exa.api_server_pb.ApiServerService/GetAccountManagedPlugins", { metadata: value })),
      self: Effect.suspend(() => transport.getJSON(restBaseURL, "/v3/self")),
      integrations: Effect.suspend(() => organizationId
        ? transport.getJSON(restBaseURL, `/v3/organizations/${encodeURIComponent(organizationId)}/integrations`) : Effect.succeed(undefined)),
      analytics: (events) => events.length === 0 ? Effect.void : Effect.asVoid(transport.unary("exa.product_analytics_pb.ProductAnalyticsService/BatchRecordAnalyticsEvents", {
        events: [...events], apiKey: credential.sessionToken,
      })),
    };
  });
}

export { getModelByUID, selectModel } from "./models/select.ts";
