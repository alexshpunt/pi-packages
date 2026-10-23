import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { ExtensionConfig } from "../../app/config.ts";
import { Accounts } from "../../features/accounts/service.ts";
import { ModelCatalog } from "../../features/catalog/service.ts";
import { DisplaySettings } from "../../features/settings/service.ts";
import { UsageChanges } from "../../features/usage/changes.ts";
import { sessionUsage, usageStatusText } from "../../features/usage/report.ts";
import type { AccountsShape } from "../../features/accounts/types.ts";
import type { ModelCatalogShape } from "../../features/catalog/types.ts";
import type { AccountUsage } from "../../features/usage/types.ts";

/** The only status key this package uses. */
export const USAGE_STATUS_KEY = "devin-usage";

export interface UsageStatusShape {
  /** Newest quota for the credential of the last model refresh. Makes no request. */
  readonly accountUsage: Effect.Effect<AccountUsage | undefined>;
  /**
   * Draws the status in the TUI only, while the session's current model is a Devin model, from the last account status and
   * the session records. `pendingMessage` is a response Pi has not stored yet. Another provider's model or turning the toggle
   * off clears only this package's key; `/devin` reports usage whatever the model.
   */
  readonly update: (context: ExtensionContext, pendingMessage?: unknown) => Effect.Effect<void>;
  /** The session whose status line follows quota changes that happen outside event handlers. */
  readonly bind: (context: ExtensionContext | undefined) => Effect.Effect<void>;
}

export class UsageStatus extends Context.Service<UsageStatus, UsageStatusShape>()("pi-devin/UsageStatus") {}

/** Newest quota for the credential of the last model refresh: the account `/devin` and the status line show. Makes no request. */
export const currentAccountUsage = (catalog: ModelCatalogShape, accounts: AccountsShape): Effect.Effect<AccountUsage | undefined> =>
  Effect.flatMap(catalog.currentScope, (scope) => scope ? accounts.usage(scope) : Effect.succeed(undefined));

/** Pi stores a message only after every `message_end` handler ran, so a just-finished response is counted explicitly. */
function branchWith(context: ExtensionContext, pendingMessage: unknown): readonly unknown[] {
  const branch = context.sessionManager.getBranch();
  if (!pendingMessage || branch.some((entry) => entry.type === "message" && entry.message === pendingMessage)) return branch;
  return [...branch, { type: "message", message: pendingMessage }];
}

export const UsageStatusLive = Layer.effect(UsageStatus, Effect.gen(function* () {
  const config = yield* ExtensionConfig;
  const settings = yield* DisplaySettings;
  const accounts = yield* Accounts;
  const catalog = yield* ModelCatalog;
  const changes = yield* UsageChanges;
  let bound: ExtensionContext | undefined;
  const accountUsage = currentAccountUsage(catalog, accounts);
  // The sidekick child shows no status line.
  const update = (context: ExtensionContext, pendingMessage?: unknown) => config.isFusionChild ? Effect.void : Effect.gen(function* () {
    if (context.mode !== "tui") return;
    const isShown = context.model?.provider === "devin" && (yield* settings.read).showUsageStatus;
    const text = isShown
      ? usageStatusText(yield* accountUsage, sessionUsage(branchWith(context, pendingMessage)), (tone, segment) => context.ui.theme.fg(tone, segment)) : undefined;
    context.ui.setStatus(USAGE_STATUS_KEY, text);
  });
  // The session may be replaced or reloaded meanwhile; its next session_start redraws.
  yield* changes.subscribe(Effect.suspend(() => bound ? update(bound) : Effect.void));
  return {
    accountUsage,
    update,
    bind: (context) => Effect.sync(() => { bound = context; }),
  } satisfies UsageStatusShape;
}));
