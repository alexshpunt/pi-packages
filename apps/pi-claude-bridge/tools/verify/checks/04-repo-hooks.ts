import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withCapturedQueries } from "../capture.js";
import { fixtureUser } from "../harness.js";
import { probeWithoutModel } from "../native-probe.js";
import { expect, type Facts, type VerificationCheck } from "../types.js";

export default {
	name: "04-repo-hooks", mode: "spawn", inputs: { hookEvents: ["SessionStart", "UserPromptSubmit"], modelEndpoint: "owned-rejecting-fixture" },
	expected: { providerHookCount: 0, summaryHookCount: 0, disableAllHooks: true },
	async run(context) {
		return withCapturedQueries(context, async (harness, captures, workspace) => {
			const directory = join(workspace.cwd, ".claude");
			mkdirSync(directory, { recursive: true });
			const script = join(workspace.root, "hook.mjs");
			const marker = join(workspace.root, "hooks.jsonl");
			writeFileSync(script, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv[2])+'\\n');\n`);
			const hooks = Object.fromEntries(["SessionStart", "UserPromptSubmit"].map(event => [event, [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${event}` }] }]]));
			writeFileSync(join(directory, "settings.json"), JSON.stringify({ hooks }));
			await harness.turn({ messages: [fixtureUser("Hook fixture.")], tools: [] });
			await harness.waitForIdle();
			await harness.runtime.isolatedStreamFn(harness.model, { messages: [fixtureUser("Summary hook fixture.")], tools: [] }, { sessionId: workspace.sessionId, cacheRetention: "none" }).result();
			const cases: Facts[] = [];
			for (let i = 0; i < captures.length; i++) {
				writeFileSync(marker, "");
				const options = captures[i].options;
				const probe = await probeWithoutModel(options);
				const events = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
				const settings = typeof options.settings === "object" ? options.settings : undefined;
				cases.push({ kind: i === 0 ? "provider" : "summary", disableAllHooks: settings?.disableAllHooks ?? false, events, ...probe });
			}
			const observed = { cases };
			expect(cases.length === 2 && cases.every(item => item.disableAllHooks === true && (item.events as unknown[]).length === 0), "04-repository-hooks-executed", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
