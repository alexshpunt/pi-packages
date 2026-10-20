import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionAccountBinding,
  findSessionAccount,
  SESSION_ACCOUNT_ENTRY_TYPE,
} from "../src/accounts/session.ts";

function custom(id: string, data: unknown, customType = SESSION_ACCOUNT_ENTRY_TYPE): SessionEntry {
  return { type: "custom", customType, data, id, parentId: null, timestamp: "2026-10-20T00:00:00Z" } as SessionEntry;
}

function assistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "2" }],
    api: "openai-completions",
    provider: "ollama-cloud",
    model: "fixture",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("findSessionAccount", () => {
  it("returns the latest valid binding for the same session ID only", () => {
    const entries = [
      custom("1", { sessionId: "parent", accountId: "default" }),
      custom("2", { sessionId: "child", accountId: "work" }),
      custom("3", { sessionId: "child", accountId: 7 }),
      custom("4", { sessionId: "child", accountId: "ignored" }, "other-extension"),
      custom("5", { sessionId: "parent", accountId: "personal" }),
    ];
    expect(findSessionAccount(entries, "child")).toBe("work");
    expect(findSessionAccount(entries, "parent")).toBe("personal");
    expect(findSessionAccount(entries, "unknown")).toBeUndefined();
    expect(findSessionAccount([custom("6", null)], "child")).toBeUndefined();
  });
});

describe("session account binding", () => {
  it("records only changed bindings and keeps memory bindings when the runtime rejects writes", () => {
    const appendEntry = vi.fn();
    const binding = createSessionAccountBinding(appendEntry);
    binding.bind("early");
    expect(appendEntry).not.toHaveBeenCalled();
    binding.start({ getSessionId: () => "session-1", getEntries: () => [] });
    expect(binding.accountId).toBeUndefined();
    binding.bind("work");
    binding.bind("work");
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(SESSION_ACCOUNT_ENTRY_TYPE, { sessionId: "session-1", accountId: "work" });
    appendEntry.mockImplementation(() => {
      throw new Error("stale runtime");
    });
    binding.bind("personal");
    expect(binding.accountId).toBe("personal");
  });

  it("delivers notifications and tolerates a stale notifier", () => {
    const binding = createSessionAccountBinding(() => {});
    const notify = vi.fn();
    binding.setNotifier(notify);
    binding.notify("switched");
    expect(notify).toHaveBeenCalledWith("switched");
    binding.setNotifier(() => {
      throw new Error("stale context");
    });
    expect(() => binding.notify("again")).not.toThrow();
  });

  describe("with a real session file", () => {
    let directory: string;
    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "ollama-session-binding-"));
    });
    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it("restores the account after a restart and gives a fork its own assignment", () => {
      const sessionDir = join(directory, "sessions");
      const original = SessionManager.create(directory, sessionDir);
      const binding = createSessionAccountBinding((type, data) => original.appendCustomEntry(type, data));
      binding.start(original);
      original.appendMessage({ role: "user", content: "1+1", timestamp: 1 });
      binding.bind("work");
      original.appendMessage(assistant());
      const file = original.getSessionFile();
      expect(file).toBeDefined();
      if (!file) throw new Error("Session file missing");

      // A new process opens the same session file: the binding survives.
      const reopened = SessionManager.open(file, sessionDir);
      const restored = createSessionAccountBinding((type, data) => reopened.appendCustomEntry(type, data));
      restored.start(reopened);
      expect(reopened.getSessionId()).toBe(original.getSessionId());
      expect(restored.accountId).toBe("work");

      // A fork copies the entries but has a new session ID, so it starts unbound.
      const forked = SessionManager.forkFrom(file, directory, sessionDir);
      const forkBinding = createSessionAccountBinding((type, data) => forked.appendCustomEntry(type, data));
      forkBinding.start(forked);
      expect(forked.getSessionId()).not.toBe(original.getSessionId());
      expect(forked.getEntries().some((entry) => entry.type === "custom")).toBe(true);
      expect(forkBinding.accountId).toBeUndefined();
    });
  });
});
