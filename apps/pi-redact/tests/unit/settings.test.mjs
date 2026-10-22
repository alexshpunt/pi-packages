import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMaskEngine } from "../../dist/engine.js";
import { REDACTION_MARKER } from "../../dist/render.js";
import {
  globalSettingsPath,
  loadSettings,
  mergeRedactionConfigs,
  parseSettingsDocument,
  projectSettingsPath,
  readSettingsFile,
  writeSettingsFile,
} from "../../dist/settings.js";
import { temporaryTree } from "../support/fixtures.mjs";

const M = REDACTION_MARKER;

function settingsTree(t, { global, project }) {
  const root = temporaryTree(t, {
    ...(global === undefined ? {} : { "agent/pi-redact/settings.json": global }),
    ...(project === undefined ? {} : { "project/.pi/pi-redact/settings.json": project }),
    "project/.keep": "",
  });
  return { agentDir: `${root}/agent`, cwd: `${root}/project` };
}

async function load(t, files, isProjectTrusted = false) {
  const dirs = settingsTree(t, files);
  const loaded = await loadSettings({ ...dirs, isProjectTrusted });
  const engine = createMaskEngine(loaded.redactor, undefined, { disabledRules: loaded.disabledRules });
  return { ...loaded, ...dirs, mask: (text) => engine.maskText(text) };
}

describe("loadSettings", () => {
  it("uses built-in rules when no settings exist", async (t) => {
    const loaded = await load(t, {});
    expect(loaded.sources).toEqual([]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.mask("password = 'hunter2-value'")).toBe(`password = '${M}'`);
  });

  it("adds global fields and rules", async (t) => {
    const global = JSON.stringify({
      sensitiveFields: ["OPENAI_KEY"],
      rules: [{ id: "custom.acme", pattern: "ACME_[A-Z0-9]+" }],
    });
    const loaded = await load(t, { global });
    expect(loaded.sources).toEqual([globalSettingsPath(loaded.agentDir)]);
    expect(loaded.mask("OPENAI_KEY=value and ACME_ABC123")).toBe(`OPENAI_KEY=${M} and ${M}`);
  });

  it("ignores project settings unless the project is trusted", async (t) => {
    const project = JSON.stringify({ sensitiveFields: ["SESSION_KEY"] });
    const untrusted = await load(t, { project });
    expect(untrusted.sources).toEqual([]);
    expect(untrusted.problems).toEqual([
      `${projectSettingsPath(untrusted.cwd)}: ignored because the project is not trusted`,
    ]);
    expect(untrusted.mask("SESSION_KEY=value")).toBe("SESSION_KEY=value");

    const trusted = await load(t, { project }, true);
    expect(trusted.sources).toEqual([projectSettingsPath(trusted.cwd)]);
    expect(trusted.mask("SESSION_KEY=value")).toBe(`SESSION_KEY=${M}`);
  });

  it("skips an invalid file entirely without repeating its contents", async (t) => {
    const secretLooking = "sk-settingsvalue0123456789";
    const loaded = await load(
      t,
      {
        global: `{"exceptions": [{"ruleId": "token.openai", "value": "${secretLooking}"`,
        project: JSON.stringify({ sensitiveFields: ["SESSION_KEY"], rules: [{ id: "bad id", pattern: secretLooking }] }),
      },
      true,
    );
    expect(loaded.sources).toEqual([]);
    expect(loaded.problems).toHaveLength(2);
    expect(loaded.problems[0]).toBe(`${globalSettingsPath(loaded.agentDir)}: is not valid JSON`);
    expect(loaded.problems[1]).toMatch(/^.*settings\.json: rules\[0\]: /);
    expect(loaded.problems.join("\n")).not.toContain(secretLooking);
    // Built-in rules still apply, and the skipped project field does not.
    expect(loaded.mask(`key ${secretLooking} SESSION_KEY=value`)).toBe(`key ${M} SESSION_KEY=value`);
  });
});

describe("global-only settings", () => {
  it("turns masking off by default and built-in rules off from the global file", async (t) => {
    const loaded = await load(t, { global: JSON.stringify({ enabled: false, disabledRules: ["token.openai"] }) });
    expect(loaded.problems).toEqual([]);
    expect(loaded.isEnabledByDefault).toBe(false);
    expect(loaded.disabledRules).toEqual(["token.openai"]);
    expect(loaded.mask("key sk-abcdefghijklmnop1234 ghp_abcdefghijklmnopqrstu")).toBe(
      `key sk-abcdefghijklmnop1234 ${M}`,
    );
  });

  it("skips a project file that sets them", async (t) => {
    const project = JSON.stringify({ enabled: false, sensitiveFields: ["SESSION_KEY"] });
    const loaded = await load(t, { project }, true);
    expect(loaded.isEnabledByDefault).toBe(true);
    expect(loaded.sources).toEqual([]);
    expect(loaded.problems).toEqual([
      `${projectSettingsPath(loaded.cwd)}: enabled: is allowed only in the global settings file`,
    ]);
  });

  it("rejects unknown rule ids and non-boolean switches", () => {
    expect(parseSettingsDocument({ enabled: "no", disabledRules: ["token.nope"] }, "global").problems).toEqual([
      "enabled: must be true or false",
      "disabledRules[0]: is not a built-in rule id",
    ]);
  });
});

describe("writeSettingsFile", () => {
  it("writes only what differs from the defaults, readable only by the user", async (t) => {
    const root = temporaryTree(t);
    const path = `${root}/agent/pi-redact/settings.json`;
    const { document } = parseSettingsDocument(
      { enabled: true, disabledRules: ["token.jwt"], piiEntities: ["EMAIL_ADDRESS"] },
      "global",
    );
    await writeSettingsFile(path, "global", document);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ disabledRules: ["token.jwt"], piiEntities: ["EMAIL_ADDRESS"] });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await readSettingsFile(path, "global")).toEqual({ state: "valid", document });
  });

  it("refuses a global-only key in a project file", async (t) => {
    const root = temporaryTree(t);
    const { document } = parseSettingsDocument({ enabled: false }, "global");
    await expect(writeSettingsFile(`${root}/.pi/pi-redact/settings.json`, "project", document)).rejects.toThrow(
      "enabled: is allowed only in the global settings file",
    );
  });
});

describe("mergeRedactionConfigs", () => {
  it("unions lists and lets a later layer replace a rule with the same id", () => {
    const merged = mergeRedactionConfigs([
      {
        sensitiveFields: ["a"],
        rules: [{ id: "custom.x", pattern: "OLD" }],
        exceptions: [{ ruleId: "custom.x", value: "v" }],
        piiEntities: ["EMAIL_ADDRESS"],
      },
      {
        sensitiveFields: ["a", "b"],
        rules: [{ id: "custom.x", pattern: "NEW" }],
        exceptions: [{ ruleId: "custom.x", value: "v" }],
        piiEntities: ["EMAIL_ADDRESS"],
      },
    ]);
    expect(merged).toEqual({
      sensitiveFields: ["a", "b"],
      rules: [{ id: "custom.x", pattern: "NEW" }],
      exceptions: [{ ruleId: "custom.x", value: "v" }],
      piiEntities: ["EMAIL_ADDRESS"],
    });
  });
});
