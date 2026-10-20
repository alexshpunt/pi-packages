import type { ModelPrice, ModelsDevReasoningOption } from "../../../src/generated/catalog.generated.ts";
import { isRecord } from "../../../src/models/types.ts";

export function isSafeModelId(id: unknown): id is string {
  return (
    typeof id === "string" && id !== "" && id.trim() === id && !["__proto__", "prototype", "constructor"].includes(id)
  );
}
const text = (value: string) =>
  value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
function money(value: string): number | undefined {
  if (value === "-") return undefined;
  if (!/^\$(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))
    throw new Error("Invalid pricing amount; refusing incomplete generation.");
  const amount = Number(value.slice(1));
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid pricing amount.");
  return amount;
}
export interface ParsedPricing {
  prices: Map<string, ModelPrice>;
  unpricedRows: string[];
  offPeakRows: string[];
}
export function parsePricingRows(html: string): ParsedPricing {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]
    .map((match) => match[0])
    .filter((table) => /href=["']\/library\//i.test(table));
  if (tables.length !== 1) throw new Error("Expected one model pricing table; schema changed.");
  const headers = [...tables[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((match) => text(match[1]).toLowerCase());
  if (JSON.stringify(headers) !== JSON.stringify(["model", "input", "cached input", "output"]))
    throw new Error("Pricing column order changed.");
  const prices = new Map<string, ModelPrice>();
  const unpricedRows: string[] = [];
  const offPeakRows: string[] = [];
  for (const row of tables[0].matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    if (!/href=["']\/library\//i.test(row[0])) continue;
    const cells = [...row[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length !== 4) throw new Error("Pricing row shape changed.");
    const anchor = /<a\b[^>]*href=["']\/library\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i.exec(cells[0]);
    const name = anchor ? text(anchor[1]) : "";
    if (!isSafeModelId(name)) throw new Error("Invalid model identifier in pricing table.");
    const input = money(text(cells[1]));
    const cached = money(text(cells[2]));
    const output = money(text(cells[3]));
    if (input !== undefined && cached !== undefined && cached > input)
      throw new Error("Cached input exceeds input price; schema changed.");
    // Preserve the existing standard-rate estimate; do not silently apply time-dependent discounts.
    if (name.endsWith(" (Off-Peak)")) {
      offPeakRows.push(name);
      continue;
    }
    if (input === undefined || output === undefined) {
      unpricedRows.push(name);
      continue;
    }
    if (prices.has(name)) throw new Error("Duplicate standard pricing row.");
    prices.set(name, { input, output, cacheRead: cached ?? input, cacheWrite: 0 });
  }
  if (!prices.size) throw new Error("No usable model prices found.");
  return { prices, unpricedRows, offPeakRows };
}
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "default"]);
export function parseReasoningOptions(raw: unknown): Record<string, ModelsDevReasoningOption[]> {
  const provider = isRecord(raw) ? raw["ollama-cloud"] : undefined;
  if (!isRecord(provider) || !isRecord(provider.models) || !Object.keys(provider.models).length)
    throw new Error("models.dev provider/model schema changed or is empty.");
  const entries: [string, ModelsDevReasoningOption[]][] = [];
  for (const [id, model] of Object.entries(provider.models)) {
    if (!isSafeModelId(id) || !isRecord(model)) throw new Error("Invalid models.dev model.");
    const options = model.reasoning_options;
    if (options == null) continue;
    if (!Array.isArray(options)) throw new Error("Invalid models.dev reasoning options.");
    const parsed: ModelsDevReasoningOption[] = [];
    for (const option of options) {
      if (!isRecord(option)) throw new Error("Invalid reasoning option.");
      if (option.type === "toggle") {
        parsed.push({ type: "toggle" });
        continue;
      }
      if (
        option.type !== "effort" ||
        !Array.isArray(option.values) ||
        option.values.some((value) => value !== null && (typeof value !== "string" || !efforts.has(value)))
      )
        throw new Error("Unsupported models.dev effort schema.");
      parsed.push({
        type: "effort",
        values: [...option.values] as Extract<ModelsDevReasoningOption, { type: "effort" }>["values"],
      });
    }
    entries.push([id, parsed]);
  }
  return Object.fromEntries(entries);
}
