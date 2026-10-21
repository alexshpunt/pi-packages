import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accountStatusLabel } from "../accounts/report.ts";
import type { OllamaAccount } from "../accounts/types.ts";
import { getCloudApiKey } from "../auth/context.ts";
import { fetchUsage, fetchUsageStats, formatUsage, type UsageStats } from "../usage/api.ts";
import { reportCommandResult } from "./command-output.ts";
import type { AccountServices } from "./ollama-command.ts";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Status line for an account the router currently skips; available accounts add nothing. */
function statusLine(services: AccountServices, account: OllamaAccount): string {
  const status = accountStatusLabel(account, services.router.readState(), Date.now());
  return status.startsWith("available") ? "" : `\n  Account status: ${status}`;
}

/**
 * `/ollama usage`: balance for every account, request statistics for the
 * session's account. With one account the output matches the single-key report.
 */
export async function showCloudUsage(ctx: ExtensionContext, services: AccountServices): Promise<void> {
  const { accounts, problems } = await services.router.listAccounts(await getCloudApiKey(ctx));
  if (accounts.length === 0) {
    reportCommandResult(ctx, "No Ollama Cloud API key configured. Set OLLAMA_API_KEY or add to auth.json.", "error");
    for (const problem of problems)
      reportCommandResult(ctx, `Ollama Cloud account [${problem.id}] unusable: ${problem.error}`, "warning");
    return;
  }
  const sessionAccount = accounts.find((account) => account.id === services.binding.accountId) ?? accounts[0];
  const isSingle = accounts.length === 1 && problems.length === 0;
  const sections: string[] = [];
  let statsError: string | undefined;
  for (const account of accounts) {
    const title = isSingle
      ? undefined
      : `Ollama Cloud usage [${account.id}]${account === sessionAccount ? " (this session)" : ""}:`;
    try {
      const data = await fetchUsage(account.apiKey);
      await services.router.recordBalance(account, data).catch(() => {});
      let stats: UsageStats | undefined;
      if (account === sessionAccount) {
        try {
          stats = await fetchUsageStats(account.apiKey);
        } catch (error) {
          statsError = errorText(error);
        }
      }
      sections.push(formatUsage(data, stats, { title }) + statusLine(services, account));
    } catch (error) {
      if (isSingle) {
        reportCommandResult(ctx, errorText(error), "error");
        return;
      }
      sections.push(`${title} unavailable (${errorText(error)})`);
    }
  }
  for (const problem of problems) sections.push(`Ollama Cloud account [${problem.id}] unusable: ${problem.error}`);
  reportCommandResult(ctx, sections.join("\n\n"), "info");
  if (statsError) reportCommandResult(ctx, `Ollama Cloud request statistics unavailable: ${statsError}`, "warning");
}
