export function getContextLength(modelInfo: Record<string, unknown>): number {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return 128000;
}
