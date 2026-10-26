import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSettings, type MemorySettings, type ModelChoice } from "./config.js";
import { MemoryRuntime } from "./runtime.js";
import { safeError, truncateBytes } from "./safety.js";
import { memoryFailureCode } from "./failure.js";
import { importLegacyMemories, manageRepositories } from "./repository-commands.js";

type Ui = ExtensionContext["ui"];
const permissionNotice = "선택한 범위의 대화 사본을 마스킹한 뒤 지정 모델 공급자에게 전송합니다. 호출 비용이나 구독 한도를 사용합니다. 원문 세션은 수정하지 않습니다.";
async function pickModel(ctx: ExtensionContext, title: string): Promise<ModelChoice | undefined> {
    const models = ctx.modelRegistry.getAvailable();
    const names = models.map(model => `${model.provider}/${model.id}`).sort();
    const choice = await ctx.ui.select(title, names);
    const model = models.find(item => `${item.provider}/${item.id}` === choice);
    if (!model) return undefined;
    const levels = getSupportedThinkingLevels(model).filter(level => level !== "off");
    const reasoning = await ctx.ui.select(`${title} 추론 강도`, ["기본값", ...levels]);
    if (!reasoning) return undefined;
    return { provider: model.provider, id: model.id, ...(reasoning === "기본값" ? {} : { reasoning: reasoning as NonNullable<ModelChoice["reasoning"]> }) };
}
export async function editSettings(runtime: MemoryRuntime, ctx: ExtensionContext): Promise<boolean> {
    if (!ctx.hasUI) throw new Error("Settings changes require an interactive or RPC confirmation UI.");
    const original = runtime.settings();
    const draft = structuredClone(original);
    const labels: Record<keyof MemorySettings, string> = {
        useMemories: "기억 조회 사용", injectSummary: "요약 자동 주입", generateMemories: "자동 추출·통합",
        extractModel: "추출 모델", consolidateModel: "통합 모델", minIdleMs: "추출 최소 유휴 시간 (ms)",
        consolidationCooldownMs: "통합 최소 간격 (ms)", pollIntervalMs: "작업 확인 간격 (ms)",
        maxRolloutsPerRun: "회당 추출 세션 수", maxRolloutAgeDays: "추출 대상 최대 나이 (일)",
        maxUnusedDays: "미사용 기억 보존 기간 (일)", maxSources: "통합 최대 자료 수", maxInputBytes: "호출 입력 상한 (UTF-8 bytes)",
        maxOutputTokens: "호출 출력 토큰 상한", timeoutMs: "호출 제한 시간 (ms)", retryDelayMs: "실패 재시도 대기 (ms)",
        maxAttempts: "동일 입력 최대 시도 수", maxCallsPerDay: "UTC 날짜별 최대 호출 수", maxInjectionBytes: "문맥 주입 상한 (UTF-8 bytes)",
    };
    while (true) {
        const keys = Object.keys(labels) as (keyof MemorySettings)[];
        const rows = keys.map(key => `${labels[key]}: ${JSON.stringify(draft[key])}`);
        const selected = await ctx.ui.select(`메모리 설정 · ${runtime.scope} · 저장 전에는 적용되지 않음`, [...rows, "저장", "취소"]);
        if (!selected || selected === "취소") return false;
        if (selected === "저장") {
            try {
                const settings = parseSettings(draft);
                if (settings.generateMemories && (!original.generateMemories || JSON.stringify(original.extractModel) !== JSON.stringify(settings.extractModel) || JSON.stringify(original.consolidateModel) !== JSON.stringify(settings.consolidateModel))) {
                    if (!(await ctx.ui.confirm("메모리 모델 전송 허용", `${permissionNotice}\n범위: ${runtime.scope}\n추출: ${JSON.stringify(settings.extractModel)}\n통합: ${JSON.stringify(settings.consolidateModel)}\n하루 최대 ${settings.maxCallsPerDay}회, 호출당 ${settings.maxInputBytes} bytes / ${settings.maxOutputTokens} 출력 토큰`))) return false;
                }
                await runtime.saveSettings(settings);
                ctx.ui.notify("설정을 저장했습니다. 새 작업부터 적용하며 기존 작업은 취소했습니다.", "info"); return true;
            } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "설정 저장 실패", "error"); continue; }
        }
        const key = keys[rows.indexOf(selected)];
        if (!key) continue;
        if (key === "extractModel" || key === "consolidateModel") {
            const choice = await pickModel(ctx, labels[key]); if (choice) draft[key] = choice;
        } else if (typeof draft[key] === "boolean") {
            (draft as unknown as Record<string, unknown>)[key] = !draft[key];
        } else {
            const input = await ctx.ui.input(labels[key], String(draft[key]));
            if (input === undefined) continue;
            if (!/^\d+$/.test(input.trim())) { ctx.ui.notify("0 이상의 정수를 입력하세요.", "error"); continue; }
            (draft as unknown as Record<string, unknown>)[key] = Number(input);
        }
    }
}
async function editNote(ui: Ui, title: string, current = ""): Promise<string | undefined> {
    const value = await ui.editor(title, current);
    if (!value?.trim()) return undefined;
    return await ui.confirm("기억 저장", truncateBytes(value, 4000)) ? value : undefined;
}
async function browse(runtime: MemoryRuntime, ctx: ExtensionContext): Promise<void> {
    const query = await ctx.ui.input("기억 검색 (빈 값: 전체 목록)", "검색어");
    if (query === undefined) return;
    const records = runtime.store.records(runtime.scope).filter(record => !query || record.body.toLowerCase().includes(query.toLowerCase()) || record.path.includes(query));
    const labels = records.map(record => record.path);
    const selected = await ctx.ui.select(`기억 ${records.length}개`, labels);
    const record = records.find(item => item.path === selected);
    if (!record) return;
    const action = await ctx.ui.select(record.path, ["본문·출처 보기", "정정", "잊기", record.isPinned ? "고정 해제" : "고정", "만료 설정", "돌아가기"]);
    if (action === "본문·출처 보기") { await ctx.ui.editor("읽기 전용 · 변경 내용은 저장되지 않습니다", runtime.store.document(record)); return; }
    if (action === "정정") {
        const body = await editNote(ctx.ui, "수정할 내용", record.body);
        if (body) { await runtime.cancel(); runtime.store.revise(runtime.scope, record.path, body); }
    } else if (action === "잊기") {
        if (await ctx.ui.confirm("기억 잊기", "이 기록과 파생 요약을 제거하고 같은 출처의 자동 재생성을 막습니다. 원본 Pi 대화, 내보내기 사본, 이미 전송한 요청은 삭제하지 않습니다.")) {
            await runtime.cancel(); runtime.store.revise(runtime.scope, record.path, null);
        }
    } else if (action === "고정" || action === "고정 해제") runtime.store.setRetention(runtime.scope, record.path, !record.isPinned, record.expiresAtMs);
    else if (action === "만료 설정") {
        const days = await ctx.ui.input("몇 일 뒤 만료할까요? (0: 만료 해제)", "30");
        if (days === undefined) return;
        if (!/^\d+$/.test(days) || Number(days) > 3650) throw new Error("만료 기간은 0–3650일이어야 합니다.");
        runtime.store.setRetention(runtime.scope, record.path, record.isPinned, Number(days) ? Date.now() + Number(days) * 86_400_000 : null);
    }
}
export async function memoryCommand(options: {
    args: string; ctx: ExtensionCommandContext; runtime: MemoryRuntime;
    show: (text: string) => void; changeScope: (mode: "workspace" | "global") => Promise<void>;
}): Promise<void> {
    const { ctx, runtime, show } = options;
    const repositoryContext = { store: runtime.store, scope: runtime.scope, cwd: runtime.cwd,
        repositoryScope: runtime.repository?.scope, signal: runtime.signal };
    const args = options.args.trim();
    if (args === "status" || (!ctx.hasUI && !args)) { show(JSON.stringify(runtime.status(), null, 2)); return; }
    if (args && !["settings", "extract", "run", "import", "cancel", "repositories", "legacy"].includes(args)) {
        show("/codex-memory [status|settings|extract|run|import|cancel|repositories|legacy]"); return;
    }
    if (args === "cancel") { await runtime.cancel(); show("메모리 작업을 취소했습니다."); return; }
    if (!ctx.hasUI) { show("변경·삭제·추출은 확인 가능한 TUI 또는 RPC에서 실행하세요. /codex-memory status는 읽기 전용입니다."); return; }
    await ctx.waitForIdle();
    let action: string | undefined = args;
    while (true) {
        if (!action) action = await ctx.ui.select(`Codex Memory v2 · ${runtime.scope}`, ["기억 조회·정정·잊기", "기억 추가", "설정", "상태·사용량", "현재 분기 추출", "지금 갱신", "기존 세션 가져오기", "기존 cwd 기억 가져오기", "저장소 연결 관리", "작업 취소", "범위 변경", "초기화", "닫기"]);
        if (!action || action === "닫기") return;
        try {
            if (action === "설정" || action === "settings") await editSettings(runtime, ctx);
            else if (action === "상태·사용량") show(JSON.stringify(runtime.status(), null, 2));
            else if (action === "기억 조회·정정·잊기") await browse(runtime, ctx);
            else if (action === "저장소 연결 관리" || action === "repositories") await manageRepositories(repositoryContext, ctx);
            else if (action === "기존 cwd 기억 가져오기" || action === "legacy") await importLegacyMemories(repositoryContext, ctx);
            else if (action === "기억 추가") {
                const note = await editNote(ctx.ui, "기억할 내용과 적용 범위");
                if (note) { await runtime.cancel(); runtime.store.addNote(runtime.scope, note); }
            } else if (["현재 분기 추출", "지금 갱신", "기존 세션 가져오기", "extract", "run", "import"].includes(action)) {
                const mode = action === "현재 분기 추출" || action === "extract" ? "current" : action === "기존 세션 가져오기" || action === "import" ? "import" : "refresh";
                if (await ctx.ui.confirm("메모리 추출·통합 실행", `${permissionNotice}\n${mode === "import" ? "기존 세션은 원래의 실행 주체를 확인할 수 없습니다. 현재 범위의 유휴 세션을 가져오는 데 동의하나요?" : "현재 설정의 모델과 호출 예산을 사용합니다."}`)) {
                    const work = runtime.run(mode);
                    if (ctx.mode === "tui") {
                        // The TUI awaits command handlers before accepting another idle input.
                        // Let this session-owned job continue so /status and /cancel can run.
                        show("메모리 작업을 시작했습니다. /codex-memory status 또는 /codex-memory cancel을 사용할 수 있습니다.");
                        void work.then(value => { if (runtime.isActive()) show(JSON.stringify(value, null, 2)); }, error => {
                            if (runtime.isActive() && memoryFailureCode(error) !== "aborted") ctx.ui.notify(safeError(error), "error");
                        });
                        return;
                    }
                    show(JSON.stringify(await work, null, 2));
                }
            } else if (action === "작업 취소") await runtime.cancel();
            else if (action === "범위 변경") {
                const mode = await ctx.ui.select("기억 범위", ["현재 저장소 / 작업 폴더", "개인 전역"]);
                if (mode && await ctx.ui.confirm("범위 변경", "기억을 합치거나 복사하지 않습니다. 기본 범위는 같은 Git 저장소의 하위 폴더·worktree가 공유하고, Git 밖에서는 cwd별로 나뉩니다. 개인 전역은 작업 공간 간 기억·설정·모델 전송 정책을 공유합니다.")) {
                    await options.changeScope(mode === "개인 전역" ? "global" : "workspace"); return;
                }
            } else if (action === "초기화") {
                if (await ctx.ui.confirm("현재 범위 초기화", "기억과 파생 파일을 비웁니다. 삭제 출처 표식은 유지해 과거 대화에서 자동 재생성되지 않게 합니다. 원본 Pi 대화와 외부 사본은 남습니다.")) {
                    await runtime.cancel(); runtime.store.reset(runtime.scope);
                }
            }
        } catch (error) { ctx.ui.notify(safeError(error), "error"); }
        if (args) return;
        action = undefined;
    }
}
