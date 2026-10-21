import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { findMaskedWrite } from "../../dist/guard.js";
import { REDACTION_MARKER } from "../../dist/render.js";
import { temporaryTree } from "../support/fixtures.mjs";

const M = REDACTION_MARKER;
const call = (toolName, input, extra = {}) => ({ type: "tool_call", toolCallId: "call-1", toolName, input, ...extra });

describe("findMaskedWrite", () => {
  it("blocks shell commands that contain the marker", async () => {
    expect(await findMaskedWrite(call("bash", { command: `export TOKEN=${M}` }), "/")).toBe("bash command");
    expect(await findMaskedWrite(call("powershell", { command: `$env:TOKEN="${M}"` }), "/")).toBe(
      "powershell command",
    );
    expect(await findMaskedWrite(call("bash", { command: "grep -n TOKEN .env" }), "/")).toBeUndefined();
  });

  it("blocks writes that add markers and allows keeping markers a file already has", async (t) => {
    const cwd = temporaryTree(t, { "docs/marker.md": `literal ${M}\n`, ".env": "API_KEY=real\n" });
    expect(await findMaskedWrite(call("write", { path: ".env", content: `API_KEY=${M}\n` }), cwd)).toBe(".env");
    expect(await findMaskedWrite(call("write", { path: "new.txt", content: M }), cwd)).toBe("new.txt");
    expect(
      await findMaskedWrite(call("write", { path: "docs/marker.md", content: `literal ${M}\nmore\n` }), cwd),
    ).toBeUndefined();
    expect(
      await findMaskedWrite(call("write", { path: "docs/marker.md", content: `literal ${M}\n${M}\n` }), cwd),
    ).toBe("docs/marker.md");
    expect(await findMaskedWrite(call("write", { path: ".env", content: "API_KEY=rotated\n" }), cwd)).toBeUndefined();
  });

  it("resolves @, absolute, and file:// paths like Pi's file tools", async (t) => {
    const cwd = temporaryTree(t, { "docs/marker.md": `literal ${M}\n` });
    const absolute = join(cwd, "docs/marker.md");
    const keep = `literal ${M}\nmore\n`;
    for (const path of ["@docs/marker.md", absolute, pathToFileURL(absolute).href])
      expect(await findMaskedWrite(call("write", { path, content: keep }), "/")).toBe(
        path === "@docs/marker.md" ? "@docs/marker.md" : undefined,
      );
    expect(await findMaskedWrite(call("write", { path: "@docs/marker.md", content: keep }), cwd)).toBeUndefined();
  });

  it("blocks edits whose replacement adds markers", async () => {
    const edit = (edits) => call("edit", { path: ".env", edits });
    expect(await findMaskedWrite(edit([{ oldText: "PORT=1", newText: `PORT=${M}` }]), "/")).toBe(".env");
    expect(
      await findMaskedWrite(
        edit([
          { oldText: "a", newText: "b" },
          { oldText: `KEY=${M}`, newText: `KEY=${M}\nPORT=2` },
        ]),
        "/",
      ),
    ).toBeUndefined();
  });

  it("checks nested calls the same way and ignores other tools", async () => {
    expect(
      await findMaskedWrite(call("bash", { command: `echo ${M}` }, { parentToolCallId: "parent" }), "/"),
    ).toBe("bash command");
    expect(await findMaskedWrite(call("read", { path: M }), "/")).toBeUndefined();
    expect(await findMaskedWrite(call("mcp__files__write", { content: M }), "/")).toBeUndefined();
  });
});
