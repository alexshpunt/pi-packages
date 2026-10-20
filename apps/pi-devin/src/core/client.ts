import { parseModelCatalog, type ModelCatalog } from "./models/catalog.ts";
import { createHash } from "node:crypto";
import { ConnectClient, ASSIGN_MODEL_METHOD, endpoint, type ConnectClientOptions } from "./protocol/transport.ts";
import { createFingerprintProvider, type FingerprintProvider } from "./protocol/fingerprint.ts";
import { wireMessages } from "./inference/messages.ts";
import { object, requiredString, type ChatMessage, type Credential, type JsonObject, type ModelInfo } from "./types.ts";

export const CLIENT_VERSION = "3000.11.92";
export type MetadataProfile = "agent" | "standalone" | "login";
const MODEL_DISPLAYS = [
  "DISPLAY_OPTION_MODEL_ROUTER", "DISPLAY_OPTION_QUICK_REVIEW", "DISPLAY_OPTION_HIDDEN_TOOL",
  "DISPLAY_OPTION_WIRE_7", "DISPLAY_OPTION_MODERN_AGENT_CHAT",
];

export interface DevinClientOptions extends Omit<ConnectClientOptions, "baseURL" | "token"> {
  profile?: MetadataProfile;
  restBaseURL?: string;
  fingerprint?: FingerprintProvider;
}

export class DevinClient {
  readonly credential: Credential;
  readonly transport: ConnectClient;
  readonly profile: MetadataProfile;
  readonly fingerprint: FingerprintProvider;
  defaultModelUid?: string;
  accountIdentityHash?: string;
  private organizationId?: string;
  private restBaseURL: string;
  private readonly hasExplicitRestURL: boolean;
  constructor(credential: Credential, options: DevinClientOptions = {}) {
    this.credential = credential;
    const { profile, fingerprint, restBaseURL, ...transportOptions } = options;
    const rpcOrigin = endpoint(credential.apiServerURL);
    const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(rpcOrigin).hostname);
    this.hasExplicitRestURL = restBaseURL !== undefined;
    this.restBaseURL = endpoint(restBaseURL ?? (isLoopback ? rpcOrigin : "https://api.devin.ai"));
    this.profile = profile ?? "agent";
    this.fingerprint = fingerprint ?? createFingerprintProvider(credential.sessionToken);
    this.transport = new ConnectClient({ baseURL: credential.apiServerURL, token: credential.sessionToken, ...transportOptions });
  }

  metadata(options: { profile?: MetadataProfile; includeModelDisplays?: boolean } = {}): JsonObject {
    const profile = options.profile ?? this.profile;
    const version = profile === "standalone" ? "0.0.0-dev" : CLIENT_VERSION;
    return {
      apiKey: this.credential.sessionToken,
      ideName: profile === "agent" ? "devin-cli" : "chisel",
      ideVersion: version,
      extensionName: "chisel",
      extensionVersion: version,
      locale: "en",
      os: process.platform,
      ...(profile === "agent" ? { ideType: "chisel" } : {}),
      ...(options.includeModelDisplays ? { supportedModelDisplays: [...MODEL_DISPLAYS] } : {}),
      f: this.fingerprint.create(),
    };
  }

  async status(signal?: AbortSignal, expectedUserId?: string, profile = this.profile): Promise<JsonObject> {
    signal?.throwIfAborted();
    const response = await this.transport.unary(
      "exa.seat_management_pb.SeatManagementService/GetUserStatus", { metadata: this.metadata({ profile }) }, signal,
    );
    const user = object(response.userStatus, "userStatus");
    if (expectedUserId && user.userId !== expectedUserId) {
      throw new Error("The signed-in user ID differs from the requested account. Sign in again; no inference was run.");
    }
    const plan = object(user.planStatus ?? {}, "planStatus");
    const info = object(plan.planInfo ?? {}, "planInfo");
    const devin = object(info.devinInfo ?? {}, "devinInfo");
    const userId = requiredString(user.userId, "userStatus.userId");
    this.accountIdentityHash = createHash("sha256").update(`${this.transport.baseURL}\0${userId}`).digest("hex");
    this.organizationId = typeof devin.orgId === "string" ? devin.orgId : undefined;
    if (!this.hasExplicitRestURL && typeof devin.apiUrl === "string" && devin.apiUrl) {
      const candidate = endpoint(devin.apiUrl);
      if (candidate !== this.restBaseURL && candidate !== this.transport.baseURL) throw new Error("Unverified REST server. Specify it explicitly with --rest-server.");
      this.restBaseURL = candidate;
    }
    const hasQuota = info.billingStrategy === "BILLING_STRATEGY_QUOTA";
    // Name, email, organization ID and the raw response are not exposed.
    return {
      ...(expectedUserId ? { identityVerified: true } : {}),
      teamsTier: user.teamsTier,
      canUseCli: info.devinInfo ? devin.canUseCli === true : undefined,
      billingStrategy: info.billingStrategy,
      dailyQuotaRemainingPercent: plan.dailyQuotaRemainingPercent ?? (hasQuota ? 0 : undefined),
      weeklyQuotaRemainingPercent: plan.weeklyQuotaRemainingPercent ?? (hasQuota ? 0 : undefined),
      dailyQuotaResetAtUnix: plan.dailyQuotaResetAtUnix,
      weeklyQuotaResetAtUnix: plan.weeklyQuotaResetAtUnix,
    };
  }

  async catalog(signal?: AbortSignal): Promise<ModelCatalog> {
    signal?.throwIfAborted();
    const response = await this.transport.unary(
      "exa.api_server_pb.ApiServerService/GetCliModelConfigs", { metadata: this.metadata({ includeModelDisplays: true }) }, signal,
    );
    const catalog = parseModelCatalog(response);
    this.defaultModelUid = catalog.defaultModelUid;
    return catalog;
  }

  async models(signal?: AbortSignal): Promise<ModelInfo[]> {
    return (await this.catalog(signal)).models;
  }

  async teamSettings(signal?: AbortSignal): Promise<JsonObject> {
    signal?.throwIfAborted();
    return this.transport.unary("exa.seat_management_pb.SeatManagementService/GetCliTeamSettings",
      { metadata: this.metadata({ includeModelDisplays: true }) }, signal);
  }

  async managedPlugins(signal?: AbortSignal): Promise<JsonObject> {
    signal?.throwIfAborted();
    // Only fetches the manifest. This does not mean installing a remote plugin or running its commands is approved.
    return this.transport.unary("exa.api_server_pb.ApiServerService/GetAccountManagedPlugins", { metadata: this.metadata() }, signal);
  }

  async assignModel(routerUid: string, cascadeId: string, message: ChatMessage | undefined, signal?: AbortSignal): Promise<{ modelUid: string; assignmentJwt: string }> {
    signal?.throwIfAborted();
    const prompt = message ? wireMessages([message])[0] : undefined;
    if (prompt) delete prompt.promptCacheOptions;
    const response = await this.transport.unary(ASSIGN_MODEL_METHOD, {
      metadata: this.metadata(), modelRouterUid: routerUid, cascadeId, ...(prompt ? { chatMessagePrompt: prompt } : {}),
    }, signal);
    const assignment = object(response.assignment, "assignment");
    return {
      modelUid: requiredString(assignment.modelUid, "assignment.modelUid"),
      assignmentJwt: message ? requiredString(assignment.assignmentJwt, "assignment.assignmentJwt") : String(assignment.assignmentJwt ?? ""),
    };
  }

  async self(signal?: AbortSignal): Promise<JsonObject> {
    return this.transport.getJSON(this.restBaseURL, "/v3/self", signal);
  }

  async integrations(signal?: AbortSignal): Promise<JsonObject | undefined> {
    if (!this.organizationId) return undefined;
    return this.transport.getJSON(this.restBaseURL, `/v3/organizations/${encodeURIComponent(this.organizationId)}/integrations`, signal);
  }

  async analytics(events: JsonObject[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (events.length === 0) return;
    await this.transport.unary("exa.product_analytics_pb.ProductAnalyticsService/BatchRecordAnalyticsEvents", {
      events, apiKey: this.credential.sessionToken,
    }, signal);
  }
}


export { getModelByUID, selectModel } from "./models/select.ts";
