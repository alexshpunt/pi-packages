import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortable, createMemoryMasker } from "./safety.js";
import { repositoryLabel, repositoryPath, type RegisteredRepository } from "./repositories.js";
import type { MemoryStore } from "./store.js";

/** Owns request-local read consent; persistent, directional grants remain in the store. */
export class RepositoryAccess {
    private request = new AbortController();
    private readonly mask = createMemoryMasker();
    private readonly grants = new Map<string, number>();
    private readonly pending = new Map<string, Promise<void>>();
    constructor(private readonly store: MemoryStore, readonly scope: string, private readonly lifetime: AbortSignal) {}
    beginRequest(): void {
        this.endRequest(); this.request = new AbortController();
    }
    endRequest(): void {
        this.request.abort(); this.grants.clear(); this.pending.clear();
    }
    canRead(scope: string): boolean {
        if (this.lifetime.aborted || !this.store.getSettings(this.scope).useMemories || !this.store.getSettings(scope).useMemories) return false;
        if (scope === this.scope) return true;
        if (!this.store.repository(scope)) return false;
        const link = this.store.readLink(this.scope, scope);
        return link.isEnabled || (!this.request.signal.aborted && this.grants.get(scope) === link.revision);
    }
    catalog(maxResults = 20) {
        if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) throw new Error("max_results must be between 1 and 100.");
        if (!this.store.getSettings(this.scope).useMemories) throw new Error("Agent memory use is disabled.");
        const values = this.store.repositories().filter(repository => this.canRead(repository.scope));
        return { current_scope: this.scope, repositories: values.slice(0, maxResults).map(repository => this.describe(repository)),
            truncated: values.length > maxResults };
    }
    describe(repository: Pick<RegisteredRepository, "scope" | "name" | "commonDirectory">, worktreeRoot?: string) {
        return { id: repository.scope, name: this.mask(repository.name), common_directory: this.mask(repository.commonDirectory),
            ...(worktreeRoot ? { worktree_root: this.mask(worktreeRoot) } : {}) };
    }
    async authorize(selector: string | undefined, path: string | undefined, ctx: ExtensionContext, callerSignal?: AbortSignal): Promise<string> {
        const signal = AbortSignal.any([this.lifetime, ...(callerSignal ? [callerSignal] : []), ...(ctx.signal ? [ctx.signal] : [])]);
        signal.throwIfAborted();
        if (!this.store.getSettings(this.scope).useMemories) throw new Error("Agent memory use is disabled.");
        const qualified = path ? repositoryPath(path) : undefined;
        const repository = selector !== undefined ? this.store.resolveRepository(selector) : qualified ? this.store.repository(qualified.scope) : undefined;
        if ((selector !== undefined || qualified) && !repository) throw new Error("Unknown repository. Register its path in /codex-memory first.");
        if (qualified && repository?.scope !== qualified.scope) throw new Error("The path and repository selector refer to different scopes.");
        const target = repository?.scope ?? this.scope;
        if (!this.store.getSettings(target).useMemories) throw new Error("Memory use is disabled in the target repository.");
        if (this.canRead(target)) return target;
        if (!repository || !ctx.hasUI) throw new Error("Cross-repository memory needs a confirmed read connection or an interactive confirmation.");
        const requestSignal = AbortSignal.any([signal, this.request.signal]);
        requestSignal.throwIfAborted();
        let pending = this.pending.get(target);
        if (!pending) {
            const revision = this.store.readLink(this.scope, target).revision;
            pending = (async () => {
                const accepted = await abortable(ctx.ui.confirm("다른 저장소 기억 읽기", `${repositoryLabel(repository)}\n이번 사용자 요청에서만 읽기를 허용합니다. 기억을 합치거나 수정하지 않습니다. 지속 허용은 /codex-memory의 저장소 연결 관리에서 설정하세요.`, { signal: requestSignal }), requestSignal);
                requestSignal.throwIfAborted();
                if (!accepted) throw new Error("Cross-repository read was not confirmed.");
                if (this.store.readLink(this.scope, target).revision !== revision || !this.store.getSettings(target).useMemories || !this.store.getSettings(this.scope).useMemories)
                    throw new Error("Memory access settings changed during confirmation.");
                this.grants.set(target, revision);
            })();
            this.pending.set(target, pending);
            const owned = pending;
            const clear = () => { if (this.pending.get(target) === owned) this.pending.delete(target); };
            void owned.then(clear, clear);
        }
        await abortable(pending, requestSignal);
        requestSignal.throwIfAborted();
        if (!this.canRead(target)) throw new Error("Memory read permission is no longer valid.");
        return target;
    }
}
