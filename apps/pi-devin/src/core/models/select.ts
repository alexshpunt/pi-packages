import type { ModelInfo } from "../types.ts";

/** Saved sessions and AssignModel results are already-resolved UIDs, not selectors. */
export function getModelByUID(models: readonly ModelInfo[], uid: string): ModelInfo {
  const model = models.find((entry) => entry.id === uid);
  if (!model) throw new Error(`${uid} is not in the model list. It is not replaced with another model automatically.`);
  if (model.isDisabled) throw new Error(`Model is disabled: ${uid}`);
  return model;
}

/** Resolves user selectors to match the CLI's selector semantics. The caller picks the default first. */
export function selectModel(models: readonly ModelInfo[], selector: string): ModelInfo {
  const normalize = (name: string) => name.trim().toLowerCase().replaceAll(" ", "-");
  const tokenize = (name: string): string[] => name.toLowerCase().match(/[a-z]+|[0-9]+/g) ?? [];
  const query = normalize(selector);
  if (!query) throw new Error("The model name is empty.");

  // Families take precedence over aliases. An alias points to a family, not a declared variant.
  const family = models.find((model) => model.familyId && normalize(model.familyId) === query)
    ?? models.find((model) => model.aliases?.some((alias) => normalize(alias) === query));
  if (family) {
    const selected = models.find((model) => !model.isDisabled
      && (family.familyId ? model.familyId === family.familyId : model.id === family.id));
    if (!selected) throw new Error(`Model is disabled: ${selector}`);
    return selected;
  }

  const exact = models.find((model) => normalize(model.id) === query)
    ?? models.find((model) => normalize(model.name) === query);
  if (exact) return getModelByUID(models, exact.id);

  // Compares whole alphanumeric tokens in any order, not arbitrary substrings.
  const words = tokenize(query);
  const candidates = words.some((word) => /[a-z]/.test(word))
    ? models.filter((model) => !model.isDisabled)
      .map((model) => ({ model, tokens: tokenize(model.id) }))
      .filter(({ tokens }) => words.every((word) => tokens.includes(word)))
    : [];
  candidates.sort((left, right) => left.tokens.length - right.tokens.length
    || (left.model.id < right.model.id ? 1 : left.model.id > right.model.id ? -1 : 0));
  if (candidates[0]) return candidates[0].model;
  throw new Error(`Model unavailable: ${selector}`);
}
