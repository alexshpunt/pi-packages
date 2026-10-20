#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discoverChecks } from "./discovery.js";
import { makeReport, safeResult, writeReport } from "./report.js";
import { assertAllowedModel, assertLiveEnvironment, MODEL_ID } from "./policy.js";
import { EnvironmentError, VerificationError, type CheckContext, type CheckResult } from "./types.js";

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELP = `사용법: pnpm --filter @buyong/pi-claude-bridge verify <검사...> [--live] [--report 경로]
       pnpm --filter @buyong/pi-claude-bridge verify --all [--live] [--report 경로]
       pnpm --filter @buyong/pi-claude-bridge verify --cache [--live] [--report 경로]
       pnpm --filter @buyong/pi-claude-bridge verify --list

--model claude-haiku-5-5  검증 모델. claude-bridge/ 접두사도 허용합니다.
--live                  구독 로그인으로 실제 모델을 호출합니다.
--report 경로           버전, 소스 해시, 검사 결과와 요청 수를 JSON으로 저장합니다.
--cache                 선택 사항인 캐시 측정 검사(cache 그룹)만 실행합니다. --all에는 포함되지 않습니다.

기본은 오프라인입니다. spawn은 네트워크 없는 실행 파일로 SDK 인자만 확인합니다.
live 검사는 --live가 없으면 skipped입니다. 전부 skipped여도 종료 0이며 pass로 세지 않습니다.
종료 코드: 0=실패 없음, 1=검사 실패, 2=사용법 또는 실행 환경 오류.
`;

export function parseCLI(argv: string[]) {
	try {
		const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
			all: { type: "boolean" }, cache: { type: "boolean" }, list: { type: "boolean" }, live: { type: "boolean" },
			report: { type: "string" }, model: { type: "string", default: MODEL_ID }, help: { type: "boolean" },
		} });
		if (values.all && positionals.length || values.list && (values.all || positionals.length)) throw new Error();
		if (values.cache && (values.all || values.list || positionals.length)) throw new Error();
		if (!values.help && !values.list && !values.all && !values.cache && !positionals.length) throw new Error();
		return { ...values, names: [...new Set(positionals)] };
	} catch { throw new EnvironmentError("invalid-arguments"); }
}

export interface CLIHost {
	appDir?: string;
	checksDir?: string;
	env?: NodeJS.ProcessEnv;
	print?: (line: string) => void;
}

export async function runCLI(argv: string[], host: CLIHost = {}): Promise<number> {
	const appDir = host.appDir ?? APP_DIR;
	const print = host.print ?? console.log;
	let args: ReturnType<typeof parseCLI>;
	let report: ReturnType<typeof makeReport> | undefined;
	const context: CheckContext = { appDir, modelId: MODEL_ID, isLive: false, apiCalls: 0 };
	try {
		args = parseCLI(argv);
		if (args.help) { print(HELP); return 0; }
		report = makeReport(appDir);
		context.modelId = args.model;
		assertAllowedModel(context.modelId);
		context.isLive = args.live === true;
		if (context.isLive) assertLiveEnvironment(host.env ?? process.env, context.modelId);
		const checks = await discoverChecks(host.checksDir ?? join(appDir, "tools/verify/checks"));
		if (args.list) { for (const check of checks) print(`${check.name}\t${check.mode}${check.group ? `\t${check.group}` : ""}`); return 0; }
		// Cache checks are optional measurements: only --cache or an explicit name runs them.
		const selected = args.cache ? checks.filter(check => check.group === "cache")
			: args.all ? checks.filter(check => check.group !== "cache") : args.names.map(name => {
			const check = checks.find(item => item.name === name);
			if (!check) throw new EnvironmentError("unknown-check");
			return check;
		});
		let hasEnvironmentError = false;
		for (const check of selected) {
			const startCalls = context.apiCalls;
			let result: CheckResult = { name: check.name, mode: check.mode, inputs: check.inputs, expected: check.expected, observed: {}, status: "skipped", apiCalls: 0 };
			if (check.mode === "live" && !context.isLive) result.observed = { reason: "requires-live" };
			else {
				try { result.observed = await check.run(context); result.status = "pass"; }
				catch (error) {
					result.status = "fail";
					result.observed = error instanceof VerificationError ? { ...error.observed, errorCode: error.code } : { errorCode: "unexpected-check-error" };
					if (error instanceof EnvironmentError) hasEnvironmentError = true;
				}
			}
			result.apiCalls = context.apiCalls - startCalls;
			result = safeResult(result);
			report.checks.push(result);
			print(`${result.status}\t${result.name}\t${result.mode}`);
			if (hasEnvironmentError) break;
		}
		report.apiCalls = context.apiCalls;
		if (args.report) writeReport(args.report, report);
		const count = (status: CheckResult["status"]) => report!.checks.filter(check => check.status === status).length;
		print(`pass ${count("pass")} / fail ${count("fail")} / skipped ${count("skipped")} / apiCalls ${context.apiCalls}`);
		return hasEnvironmentError ? 2 : count("fail") ? 1 : 0;
	} catch (error) {
		const code = error instanceof VerificationError ? error.code : "verification-environment-error";
		print(`error: ${code}`);
		if (args?.report && report) {
			report.apiCalls = context.apiCalls;
			report.errorCode = code;
			try { writeReport(args.report, report); } catch { print("error: report-write-failed"); }
		}
		return 2;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCLI(process.argv.slice(2));
