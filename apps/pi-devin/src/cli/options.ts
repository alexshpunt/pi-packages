import { parseArgs } from "node:util";

export function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 2_147_483_647) throw new Error("A positive integer option is required.");
  return number;
}

export function parseCLIOptions(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" }, json: { type: "boolean" },
      "allow-model-calls": { type: "boolean" }, model: { type: "string" }, prompt: { type: "string" },
      image: { type: "string", multiple: true }, "expect-user-id": { type: "string" },
      "prompt-file": { type: "string" }, output: { type: "string" },
      "max-tokens": { type: "string" }, "timeout-ms": { type: "string" },
      "max-model-calls": { type: "string" }, resume: { type: "string" },
      "enable-add-tool": { type: "boolean" }, "no-title": { type: "boolean" }, "no-analytics": { type: "boolean" },
      "rest-server": { type: "string" }, "api-server-url": { type: "string" }, "webapp-url": { type: "string" },
      "login-encoding": { type: "string" }, "login-api-url": { type: "string" },
      "force-manual-token-flow": { type: "boolean" }, "no-browser": { type: "boolean" },
    },
  });
}
