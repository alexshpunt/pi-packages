import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryStore } from "./store.js";
import { abortable, truncateBytes } from "./safety.js";
import { MemoryUserError } from "./failure.js";
import { findRepository, repositoryLabel } from "./repositories.js";

export interface RepositoryCommandContext {
    readonly store: Pick<MemoryStore, "scopeFor" | "repositories" | "repository" | "readLink" | "registerRepository" | "setReadLink" | "legacyMemories" | "state" | "document" | "importLegacy">;
    readonly scope: string;
    readonly cwd: string;
    readonly repositoryScope: string | undefined;
    readonly signal: AbortSignal;
}

function management(memory: RepositoryCommandContext, ctx: ExtensionContext) {
    if (!ctx.hasUI) throw new MemoryUserError("Repository management requires a confirmation UI.");
    const signal = AbortSignal.any([memory.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    const check = () => {
        signal.throwIfAborted();
        if (memory.store.scopeFor(memory.cwd) !== memory.scope) throw new MemoryUserError("The active memory scope changed. Open management again.");
    };
    check();
    return { signal, check, select: (title: string, rows: string[]) => abortable(ctx.ui.select(title, rows, { signal }), signal),
        input: (title: string, placeholder: string) => abortable(ctx.ui.input(title, placeholder, { signal }), signal),
        confirm: (title: string, text: string) => abortable(ctx.ui.confirm(title, text, { signal }), signal) };
}
export async function manageRepositories(memory: RepositoryCommandContext, ctx: ExtensionContext): Promise<void> {
    const ui = management(memory, ctx);
    const action = await ui.select("저장소 연결 관리", ["저장소 등록·읽기 연결", "읽기 연결 해제", "취소"]);
    if (!action || action === "취소") return;
    ui.check();
    const repositories = memory.store.repositories().filter(repository => repository.scope !== memory.scope &&
        (action !== "읽기 연결 해제" || memory.store.readLink(memory.scope, repository.scope).isEnabled));
    const labels = repositories.map(repositoryLabel);
    const choice = await ui.select("대상 저장소", [...labels, ...(action === "읽기 연결 해제" ? [] : ["경로로 등록"]), "취소"]);
    if (!choice || choice === "취소") return;
    ui.check();
    let location;
    let repository = repositories[labels.indexOf(choice)];
    if (choice === "경로로 등록") {
        const path = await ui.input("Git 작업 폴더의 절대 경로", "/path/to/repository");
        if (!path) return;
        if (!isAbsolute(path)) throw new MemoryUserError("Enter an absolute working-directory path.");
        location = findRepository(path);
        if (!location) throw new MemoryUserError("No supported Git working tree was found at that path.");
        if (location.scope === memory.scope) throw new MemoryUserError("This is already the current memory repository.");
        repository = memory.store.repository(location.scope) ?? { scope: location.scope, name: location.name,
            commonDirectory: location.commonDirectory, worktreeRoots: [location.worktreeRoot], sessionDirectories: [] };
    }
    if (!repository) return;
    const mode = action === "읽기 연결 해제" ? "해제" : await ui.select(repositoryLabel(repository), ["등록만", "읽기 연결 저장", "취소"]);
    if (!mode || mode === "취소") return;
    const notice = mode === "해제" ? "이 방향의 지속 읽기 허용과 이전 일회 허용을 무효화합니다. 다음 미등록 요청은 다시 확인합니다. 이미 대화에 전달한 내용은 지우지 않습니다."
        : mode === "등록만" ? "저장소 이름·경로만 등록하며 기존 권한은 변경하지 않습니다. 읽기 연결이 없다면 모델의 최초 조회에는 사용자 요청마다 확인이 필요합니다."
            : "현재 범위에서 대상 저장소로의 지속 읽기를 허용합니다. 반대 방향의 권한, 자동 주입, 기억 복사·쓰기 권한은 부여하지 않습니다.";
    if (!(await ui.confirm("저장소 연결 변경", `${memory.scope} → ${repositoryLabel(repository)}\n${notice}`))) return;
    ui.check();
    if (location) {
        if (findRepository(location.worktreeRoot)?.scope !== location.scope) throw new MemoryUserError("Repository location changed during confirmation.");
        memory.store.registerRepository(location);
    }
    if (mode !== "등록만") memory.store.setReadLink(memory.scope, repository.scope, mode === "읽기 연결 저장");
    ctx.ui.notify("저장소 연결 설정을 반영했습니다.", "info");
}
export async function importLegacyMemories(memory: RepositoryCommandContext, ctx: ExtensionContext): Promise<void> {
    const ui = management(memory, ctx);
    if (!memory.repositoryScope || memory.scope !== memory.repositoryScope) throw new MemoryUserError("Select the current Git repository scope before importing cwd memories.");
    const choice = await ui.select("기존 cwd 기억의 위치", ["현재 폴더", "다른 하위 폴더·worktree", "취소"]);
    if (!choice || choice === "취소") return;
    const cwd = choice === "현재 폴더" ? memory.cwd : await ui.input("이전 cwd의 절대 경로", memory.cwd);
    if (!cwd) return;
    if (!isAbsolute(cwd) || findRepository(cwd)?.scope !== memory.scope) throw new MemoryUserError("The old cwd must belong to this Git repository.");
    ui.check();
    const legacy = memory.store.legacyMemories(cwd, memory.scope);
    const targetRevision = memory.store.state(memory.scope).revision;
    const all = `전체 선택 (${legacy.records.length}개)`;
    const selected = await ui.select(`기존 기억 ${legacy.records.length}개 · 제외 표식 ${legacy.excludedSources}개`, [
        ...legacy.records.map(record => record.path), ...(legacy.records.length ? [all] : []), "잊기 표식만 가져오기", "취소",
    ]);
    if (!selected || selected === "취소") return;
    const records = selected === all ? legacy.records : legacy.records.filter(record => record.path === selected);
    const preview = records.length === 1 ? memory.store.document(records[0]!) : records.map(record => record.path).join("\n");
    const notice = `원본: ${JSON.stringify(cwd)} (${legacy.scope})\n대상: ${memory.scope}\n선택: ${records.length}개\n`
        + `원본은 그대로 두고 선택한 기억만 복사합니다. 모델·생성 동의·사용량은 이전하지 않습니다. 복사 후에는 대상의 기존 조회·생성 설정을 따릅니다. 잊기 표식 ${legacy.excludedSources}개도 적용하며, 대상의 동일 출처 ${legacy.affectedPaths.length}개는 제거됩니다.\n`
        + truncateBytes([...legacy.affectedPaths.map(path => `제거: ${path}`), preview].join("\n"), 6000)
        + "\n복사 이후 두 범위는 독립적입니다. 원본의 후속 수정·삭제는 자동 동기화되지 않습니다.";
    if (!(await ui.confirm("선택한 기존 기억 가져오기", notice))) return;
    ui.check();
    const result = memory.store.importLegacy(cwd, memory.scope, records.map(record => record.id), legacy.revision, targetRevision);
    ctx.ui.notify(`가져옴 ${result.imported} · 건너뜀 ${result.skipped} · 제외에 따른 제거 ${result.removed}`, "info");
}
