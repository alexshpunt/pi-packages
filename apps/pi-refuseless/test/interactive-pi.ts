/**
 * Runs Pi's own interactive mode in-process against a virtual terminal, so a test can type `/login`,
 * pick entries and read what Pi printed. The package loads through Pi's resource loader from its
 * directory, exactly as `pi -e <dir>` loads it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  InteractiveMode,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";

export const KEYS = { enter: "\r", escape: "\x1b", down: "\x1b[B", up: "\x1b[A", shiftTab: "\x1b[Z" } as const;

/** A terminal that records everything Pi writes and lets the test send keystrokes. */
export class VirtualTerminal implements Terminal {
  private written = "";
  private onInput: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void) {
    this.onInput = onInput;
  }
  stop() {
    this.onInput = undefined;
  }
  async drainInput() {}
  write(data: string) {
    this.written += data;
  }
  get columns() {
    return 160;
  }
  get rows() {
    return 50;
  }
  get kittyProtocolActive() {
    return false;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}

  /** What was written from `since` (a `mark()`), without escape sequences. */
  text(since = 0): string {
    return stripTerminalSequences(this.written.slice(since));
  }
  /** Position in the raw output, between two writes, to search from with `waitFor(text, since)`. */
  mark(): number {
    return this.written.length;
  }
  async type(data: string) {
    if (!this.onInput) throw new Error("Terminal is not started");
    this.onInput(data);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  /** Waits until `text` appears after `since`. */
  async waitFor(text: string, since = 0, timeoutMs = 10_000): Promise<void> {
    await this.waitForAny([text], since, timeoutMs);
  }
  /** Waits until one of `texts` appears after `since` and returns the first that did. */
  async waitForAny(texts: readonly string[], since = 0, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = this.text(since);
      const found = texts.find((text) => screen.includes(text));
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${JSON.stringify(texts)}. Screen tail:\n${this.text().slice(-3000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export interface InteractivePi {
  terminal: VirtualTerminal;
  runtime: AgentSessionRuntime;
  /** Types a line into the editor and submits it. */
  submit(line: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts Pi on `agentDir`/`cwd` with only the package at `packageDir` loaded, like
 * `pi --no-skills --no-prompt-templates --no-themes --no-context-files -e <packageDir>`.
 * `baseUrl` is written to the agent's models.json as the Refuseless endpoint; startup fails if any
 * Refuseless model would still reach another host. Without `packageDir`, Pi starts with no extension.
 * The caller sets PI_CODING_AGENT_DIR, PI_OFFLINE and PI_SKIP_VERSION_CHECK before calling. PI_OFFLINE keeps
 * Pi's startup checks local; model catalogs still refresh over the network, as without it, but Pi's own
 * catalog server is replaced by a closed local port so that only the Refuseless mock is contacted.
 */
export async function startInteractivePi(options: {
  agentDir: string;
  cwd: string;
  packageDir?: string;
  baseUrl: string;
  /** Extra models.json providers, to check that Pi never falls back to another provider's model. */
  otherProviders?: Record<string, unknown>;
  /** Settings the user would have, such as a saved default model. */
  settings?: Record<string, unknown>;
}): Promise<InteractivePi> {
  const { agentDir, cwd, packageDir, baseUrl, otherProviders, settings: extraSettings } = options;
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({ providers: { refuseless: { baseUrl }, ...otherProviders } }),
  );
  const sessionManager = SessionManager.inMemory(cwd);
  const runtime = await createAgentSessionRuntime(
    async ({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
    }) => {
      const settingsManager = SettingsManager.inMemory({
        defaultProjectTrust: "never",
        enableInstallTelemetry: false,
        retry: { enabled: false },
        compaction: { enabled: false },
        quietStartup: true,
        ...extraSettings,
      });
      // ModelRuntime reads PI_OFFLINE once, when it is created.
      const offline = process.env.PI_OFFLINE;
      delete process.env.PI_OFFLINE;
      const modelRuntime = await ModelRuntime.create({
        authPath: join(runtimeAgentDir, "auth.json"),
        modelsPath: join(runtimeAgentDir, "models.json"),
        catalogBaseUrl: "http://127.0.0.1:1",
      }).finally(() => {
        if (offline !== undefined) process.env.PI_OFFLINE = offline;
      });
      const services = await createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        modelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          additionalExtensionPaths: packageDir ? [packageDir] : [],
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: runtimeSessionManager,
        sessionStartEvent,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir, sessionManager },
  );
  const errors = runtime.services.resourceLoader.getExtensions().errors;
  if (errors.length) throw new Error(`Extension load failed: ${JSON.stringify(errors)}`);
  const unredirected = runtime.services.modelRuntime
    .getModels("refuseless")
    .filter((model) => model.baseUrl !== baseUrl);
  if (unredirected.length) {
    await runtime.dispose();
    throw new Error(`Refuseless models not redirected to ${baseUrl}: ${unredirected.map((model) => model.baseUrl)}`);
  }

  initTheme(undefined, true);
  const terminal = new VirtualTerminal();
  const mode = new InteractiveMode(runtime, { terminal });
  await mode.init();
  // run() reuses the finished init and then reads editor input until stop().
  void mode.run().catch(() => {});

  return {
    terminal,
    runtime,
    async submit(line: string) {
      await terminal.type(line);
      await terminal.type(KEYS.enter);
    },
    async stop() {
      mode.stop();
      await runtime.dispose();
    },
  };
}
