/**
 * Config values that reference the environment or a command, as `env`, `headers`, and
 * `oauth.clientSecret` of a server allow, resolved the way pi resolves them in `models.json`:
 * - `!command` runs the command and uses its trimmed stdout.
 * - Otherwise `$NAME` and `${NAME}` are replaced with environment variables; `$$` is a literal `$`
 *   and `$!` a literal `!`. Other text is literal.
 * Values are resolved on every connection, so a changed variable or command output applies on reconnect.
 */

import { execSync } from "node:child_process";

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;
/** Commands that do not finish in this time count as failed. */
const COMMAND_TIMEOUT_MS = 10_000;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "literal") previous.value += value;
  else parts.push({ type: "literal", value });
}

function parseTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollarIndex));
    const nextChar = config[dollarIndex + 1];
    if (nextChar === "$" || nextChar === "!") {
      appendLiteral(parts, nextChar);
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral(parts, "$");
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME.test(name)) parts.push({ type: "env", name });
      else appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
      index = endIndex + 1;
      continue;
    }
    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX);
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, "$");
    index = dollarIndex + 1;
  }
  return parts;
}

function envValue(name: string): string | undefined {
  return process.env[name] || undefined;
}

/** The trimmed stdout of `command`, or undefined when it fails or prints nothing. */
function runCommand(command: string): string | undefined {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a config value; `description` names it in the error when it cannot be resolved. */
export function resolveConfigValueOrThrow(config: string, description: string): string {
  if (config.startsWith("!")) {
    const value = runCommand(config.slice(1));
    if (value === undefined) throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
    return value;
  }
  const parts = parseTemplate(config);
  const missing = new Set<string>();
  for (const part of parts) {
    if (part.type === "env" && envValue(part.name) === undefined) missing.add(part.name);
  }
  if (missing.size > 0) {
    const variables = missing.size === 1 ? "environment variable" : "environment variables";
    throw new Error(`Failed to resolve ${description} from ${variables}: ${[...missing].join(", ")}`);
  }
  return parts.map((part) => (part.type === "literal" ? part.value : envValue(part.name))).join("");
}

/** Resolve every header value; `description` names the headers' owner in errors. */
export function resolveHeadersOrThrow(
  headers: Record<string, string> | undefined,
  description: string,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
