import { Context } from "effect";

export interface LoginSettings {
  apiServerURL?: string;
  webappURL?: string;
  devinAPIURL?: string;
  timeoutMs?: number;
}

/** Values the entry point chooses for one extension instance. Read by the services that need them. */
export interface ExtensionConfigShape {
  /** Clock of quota timestamps and session check times. */
  readonly now: () => number;
  /**
   * This Pi is the Fusion sidekick child: it lists every exact UID, builds no Fusion entry, ignores the recommended filter,
   * and registers no sidekick tool, `/devin`, `/devin-fusion` or status line.
   */
  readonly isFusionChild: boolean;
  /** Endpoints and the time limit of `/login`. */
  readonly login: LoginSettings;
  /** Pi agent directory that holds sidekick session files. Read when a handoff starts. */
  readonly agentDir: () => string;
}

export class ExtensionConfig extends Context.Service<ExtensionConfig, ExtensionConfigShape>()("pi-devin/ExtensionConfig") {}
