// Inquirer adapter for release-it's prompt, plus a plugin that pins the chosen version and mode.
//
// release-it 21.0.1 accepts a prompt instance as the second argument of `release()` and
// calls only `register()` and `show()` on it. That surface is read from source, not a
// documented API, so re-check lib/prompt.js and lib/plugin/git/Git.js before upgrading.

import { confirm } from "@inquirer/prompts";
import { Plugin } from "release-it";

export class ReleaseStopped extends Error {
  constructor(message) {
    super(message, { cause: "INFO" });
    this.name = "ReleaseStopped";
  }
}

// Takes the pending prompt (not its awaited answer) so Ctrl+C maps to this stage.
export async function requireAnswer(pendingAnswer, stage) {
  try {
    return await pendingAnswer;
  } catch (error) {
    if (error instanceof Error && ["ExitPromptError", "AbortPromptError"].includes(error.name)) {
      throw new ReleaseStopped(`Cancelled at ${stage}.`);
    }
    throw error;
  }
}

export class InquirerPrompt {
  prompts = new Map();
  completed = [];
  attempted = [];
  tagName;

  register(definitions, namespace = "default") {
    this.prompts.set(namespace, { ...this.prompts.get(namespace), ...definitions });
  }

  async show({ enabled = true, prompt, namespace = "default", task, context }) {
    if (!enabled) return false;
    const definition = this.prompts.get(namespace)?.[prompt];
    const expected = ["commit", "tag", "push"][this.completed.length];
    if (namespace !== "git" || prompt !== expected || definition?.type !== "confirm") {
      throw new Error(`Unsupported release prompt: ${namespace}.${prompt}`);
    }
    if (typeof task !== "function") throw new Error(`Missing task: ${namespace}.${prompt}`);
    this.tagName = context.tagName;
    // `(Y/n)`: Enter approves the displayed action, push (and the publish it triggers) included.
    const answer = await requireAnswer(confirm({ message: definition.message(context), default: true }), prompt);
    // Returning false would skip only this step and let release-it run the next one.
    if (answer !== true) throw new ReleaseStopped(`Declined ${prompt}.`);
    this.attempted.push(prompt);
    const result = await task(answer);
    this.completed.push(prompt);
    return result;
  }
}

/** The dry run never asks. A question would mean release-it left CI mode, so it stops instead of waiting. */
export class NoPrompt {
  register() {}

  show({ enabled = true, namespace = "default", prompt }) {
    if (!enabled) return false;
    throw new Error(`The dry run does not answer prompts: ${namespace}.${prompt}`);
  }
}

// Loaded as the first external plugin, so it runs before any file is written.
export default class SelectedVersionGuard extends Plugin {
  beforeBump() {
    const { version, latestVersion } = this.config.getContext();
    if (version !== this.options.selectedVersion || latestVersion !== this.options.currentVersion) {
      throw new Error("Resolved version differs from the displayed selection; stopping before bump.");
    }
    if (this.options.isDryRun) {
      if (!this.config.isDryRun) throw new Error("The dry run must keep release-it in dry-run mode; stopping before bump.");
    } else if (this.config.isCI || this.config.isPromptOnlyVersion || this.config.isDryRun) {
      throw new Error("Interactive confirmations must remain enabled.");
    }
  }
}
