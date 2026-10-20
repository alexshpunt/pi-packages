import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withCapturedQueries } from "../capture.js";
import { fixtureUser } from "../harness.js";
import { probeWithoutModel } from "../native-probe.js";
import { captureSpawn, flagValues } from "../spawn.js";
import { expect, type Facts, type VerificationCheck } from "../types.js";

export default {
	name: "04-summary-settings", mode: "spawn",
	inputs: { userEnvCanary: "fixture-user-loaded", apiKeyHelperSource: "temporary-project-settings", negativeControl: "settingSources-empty" },
	expected: { defaultSettingSources: true, disableAllHooks: true, claudeMdExcludes: true, envAndHelperApplied: true, strictMcpConfig: true },
	async run(context) {
		return withCapturedQueries(context, async (harness, captures, workspace) => {
			const directory = join(workspace.cwd, ".claude");
			mkdirSync(directory, { recursive: true });
			const marker = join(workspace.root, "settings-observed.json");
			const helper = join(workspace.root, "key-helper.mjs");
			writeFileSync(helper, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, JSON.stringify({userCanary:process.env.BRIDGE_VERIFY_USER_SETTING??null,projectCanary:process.env.BRIDGE_VERIFY_PROJECT_SETTING??null})); process.stdout.write('verification-invalid-key');\n`);
			writeFileSync(join(workspace.root, "claude/settings.json"), JSON.stringify({ env: { BRIDGE_VERIFY_USER_SETTING: "fixture-user-loaded" } }));
			writeFileSync(join(directory, "settings.json"), JSON.stringify({ env: { BRIDGE_VERIFY_PROJECT_SETTING: "fixture-project-loaded" }, apiKeyHelper: `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}` }));
			await harness.turn({ messages: [fixtureUser("Provider settings fixture.")], tools: [] });
			await harness.waitForIdle();
			await harness.runtime.isolatedStreamFn(harness.model, { messages: [fixtureUser("Summary settings fixture.")], tools: [] }, { sessionId: workspace.sessionId, cacheRetention: "none" }).result();
			const cases: Facts[] = [];
			for (let i = 0; i < captures.length; i++) {
				const options = captures[i].options;
				const spawn = await captureSpawn(options, workspace);
				rmSync(marker, { force: true });
				const probe = await probeWithoutModel(options, true);
				const settings = typeof options.settings === "object" ? options.settings : undefined;
				const helperObserved = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null;
				cases.push({
					kind: i === 0 ? "provider" : "summary",
					defaultSettingSources: options.settingSources === undefined && flagValues(spawn.argv, "setting-sources").length === 0,
					disableAllHooks: settings?.disableAllHooks ?? false,
					claudeMdExcludes: settings?.claudeMdExcludes ?? [],
					strictMcpConfig: options.strictMcpConfig === true,
					toolsEmpty: Array.isArray(options.tools) && options.tools.length === 0,
					helperExecuted: helperObserved !== null,
					envAndHelperApplied: helperObserved?.userCanary === "fixture-user-loaded",
					// CC 2.1.303 did not expose the project env canary to this helper,
					// with hooks either enabled or disabled. Do not infer global env behavior.
					projectCanaryInHelper: helperObserved?.projectCanary === "fixture-project-loaded",
					probe,
				});
			}
			rmSync(marker, { force: true });
			const controlProbe = await probeWithoutModel({ ...captures[1].options, settingSources: [] }, true);
			const isolatedControl = { helperExecuted: existsSync(marker), probe: controlProbe };
			const observed = { cases, isolatedControl };
			expect(cases.length === 2 && cases.every(item => item.defaultSettingSources && item.disableAllHooks && (item.claudeMdExcludes as string[]).length > 0 && item.strictMcpConfig && item.toolsEmpty && item.envAndHelperApplied) && !isolatedControl.helperExecuted, "04-summary-settings-not-applied", observed);
			return observed;
		});
	},
} satisfies VerificationCheck;
