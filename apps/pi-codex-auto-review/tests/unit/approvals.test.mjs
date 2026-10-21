import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
    ApprovalManager,
    FileGrantPersistence,
} from "../../dist/approvals.js";
import {
    AuditLog,
    redact,
} from "../../dist/audit.js";
import { decision } from "../../dist/contracts.js";
import { ReviewContextStore } from "../../dist/review/context.js";
import {
    ReviewLifecycle,
    reviewFeedback,
} from "../../dist/review/lifecycle.js";
import { ControlledClock, fixture } from "../harness/fixtures.mjs";

const provider = {
    complete: async () => '{"decision":"ask","reason":"confirm"}',
};
const context = (choice) => ({
    provider,
    trustedAuthorization: "",
    ui: { select: async () => choice },
});
function manager(options = {}) {
    return new ApprovalManager({
        reviewTimeoutMs: 500,
        approvalTimeoutMs: 500,
        audit: new AuditLog(),
        ...options,
    });
}
test("[grants] disabled categories never call reviewers or dialogs and user routing skips the provider", async (t) => {
    const f = await fixture(t),
        action = f.action("bash", { command: "example" });
    let reviews = 0,
        dialogs = 0;
    const request = {
        trustedAuthorization: "",
        provider: {
            complete: async () => {
                reviews++;
                return '{"decision":"allow","reason":"ok"}';
            },
        },
        ui: {
            select: async () => {
                dialogs++;
                return "once";
            },
        },
    };
    for (const approvalPolicy of ["never", { sandbox: false, rules: true }]) {
        expect(
            (
                await manager({ approvalPolicy }).admit(
                    action,
                    decision(action, "ask", "boundary"),
                    request,
                )
            ).isAllowed,
        ).toBe(false);
    }
    expect(reviews).toBe(0);
    expect(dialogs).toBe(0);
    expect(
        (
            await manager({ approvalsReviewer: "user" }).admit(
                action,
                decision(action, "ask", "boundary"),
                request,
            )
        ).isAllowed,
    ).toBe(true);
    expect(reviews).toBe(0);
    expect(dialogs).toBe(1);
});
test("[grants] denial breaker uses three consecutive or ten of fifty reviews and retains at most ten recent denials", async (t) => {
    const f = await fixture(t),
        action = f.action("bash", { command: "owned" });
    const denied = {
        status: "denied",
        actionDigest: action.digest,
        contextDigest: "context",
        policyDigest: "policy",
        assessment: {
            risk_level: "high",
            user_authorization: "low",
            outcome: "deny",
            rationale: "denied",
        },
    };
    const lifecycle = new ReviewLifecycle();
    expect(lifecycle.record(action, "context", denied).shouldInterrupt).toBe(
        false,
    );
    expect(lifecycle.record(action, "context", denied).shouldInterrupt).toBe(
        false,
    );
    expect(lifecycle.record(action, "context", denied).shouldInterrupt).toBe(
        true,
    );
    expect(lifecycle.signal.aborted).toBe(true);
    lifecycle.startTurn();
    expect(lifecycle.signal.aborted).toBe(false);
    for (let i = 0; i < 10; i++) {
        expect(
            lifecycle.record(action, "context", denied).shouldInterrupt,
        ).toBe(i === 9);
        lifecycle.record(action, "context", {
            ...denied,
            status: "timed-out",
            failure: "timeout",
            reason: "timeout",
        });
    }
    expect(lifecycle.recentDenials.length).toBe(10);
    lifecycle.startTurn();
    for (let i = 0; i < 9; i++) {
        lifecycle.record(action, "context", denied);
        lifecycle.record(action, "context");
    }
    for (let i = 0; i < 50; i++) lifecycle.record(action, "context");
    expect(lifecycle.record(action, "context", denied).shouldInterrupt).toBe(
        false,
    );
    expect(reviewFeedback(denied).message).toMatch(/policy circumvention/);
    expect(reviewFeedback({ ...denied, status: "timed-out" }).message).toMatch(
        /not evidence/,
    );
});
test("[cancellation] direct user actions preserve caller and session cancellation without resetting a stopped model turn", async (t) => {
    const f = await fixture(t),
        m = manager(),
        modelAction = f.action("bash", { command: "pwd" }),
        userAction = f.action(
            "bash",
            { command: "pwd" },
            { source: "user-bash" },
        );
    const denied = {
        provider: { complete: async () => '{"outcome":"deny"}' },
        trustedAuthorization: "",
    };
    for (let index = 0; index < 3; index++)
        await m.admit(
            modelAction,
            decision(modelAction, "ask", "review"),
            denied,
        );
    expect(m.lifecycle.signal.aborted).toBe(true);
    expect(
        (
            await m.admit(
                userAction,
                decision(userAction, "allow", "owned"),
                denied,
            )
        ).isAllowed,
    ).toBe(true);
    expect(
        (
            await m.admit(
                modelAction,
                decision(modelAction, "allow", "owned"),
                denied,
            )
        ).isAllowed,
    ).toBe(false);
    const caller = new AbortController();
    caller.abort();
    expect(
        (
            await m.admit(userAction, decision(userAction, "allow", "owned"), {
                ...denied,
                signal: caller.signal,
            })
        ).isAllowed,
    ).toBe(false);
    m.reset("another-session");
    expect(
        (
            await m.admit(
                userAction,
                decision(userAction, "allow", "owned"),
                denied,
            )
        ).isAllowed,
    ).toBe(false);
});
test("[grants] exact one-use retry reaches review again while changed inputs and consumed markers do not authorize", async (t) => {
    const f = await fixture(t),
        m = manager(),
        action = f.action("write", {
            path: join(f.outside, "sentinel.txt"),
            content: "owned",
        }),
        store = new ReviewContextStore();
    store.reset(action.sessionId);
    store.authorize("Only the named owned effect.");
    const reviewContext = store.snapshot(10000),
        requests = [];
    const provider = {
        complete: async (request) => {
            const data = JSON.parse(request.data);
            requests.push(data);
            return data.context.items.some(
                (item) =>
                    item.source === "user-confirmation" &&
                    item.content?.type === "exact-action-retry-approval",
            )
                ? '{"outcome":"allow","risk_level":"high","user_authorization":"high"}'
                : '{"outcome":"deny","risk_level":"high","user_authorization":"low"}';
        },
    };
    const context = { provider, reviewContext, trustedAuthorization: "" },
        invoke = (action) =>
            m.admit(
                action,
                decision(action, "ask", "owned", {
                    readPaths: [],
                    writePaths: [join(f.outside, "sentinel.txt")],
                    domains: [],
                }),
                context,
            );
    const initial = await invoke(action);
    expect(initial.isAllowed).toBe(false);
    expect(initial.denialId).toBeTruthy();
    const current = {
        sessionId: action.sessionId,
        contextId: reviewContext.contextId,
        cwd: action.cwd,
        policyRevision: action.policyRevision,
        permissionDigest: action.permissionDigest,
    };
    expect(() =>
        m.lifecycle.authorizeRetry(initial.denialId, {
            ...current,
            contextId: "changed",
        }),
    ).toThrow(/current context/);
    m.lifecycle.authorizeRetry(initial.denialId, current);
    expect(
        (
            await invoke(
                f.action("write", { ...action.args, content: "different" }),
            )
        ).isAllowed,
    ).toBe(false);
    const exact = await invoke(f.action("write", action.args));
    expect(exact.isAllowed).toBe(true);
    expect(exact.delta.writePaths).toStrictEqual([
        join(f.outside, "sentinel.txt"),
    ]);
    expect((await invoke(f.action("write", action.args))).isAllowed).toBe(
        false,
    );
    expect(
        requests.filter((request) =>
            request.context.items.some(
                (item) => item.source === "user-confirmation",
            ),
        ).length,
    ).toBe(1);
    const critical = m.lifecycle.record(action, reviewContext.contextId, {
        status: "denied",
        actionDigest: action.digest,
        contextDigest: reviewContext.digest,
        policyDigest: "policy",
        assessment: {
            risk_level: "critical",
            user_authorization: "high",
            outcome: "deny",
            rationale: "Critical effect",
        },
    });
    expect(
        m.lifecycle.authorizeRetry(critical.denialId, current).assessment
            .risk_level,
    ).toBe("critical");
    expect(
        m.lifecycle.consumeRetry(action, reviewContext.contextId),
        "An earlier critical label must not prevent a fresh assessment",
    ).toBeTruthy();
    m.reset("new-session");
    expect(m.lifecycle.recentDenials.length).toBe(0);
});
test("[queue] concurrent denials interrupt once and cancel a still-running review before it can authorize", async (t) => {
    const f = await fixture(t),
        m = manager(),
        pending = [],
        signals = [];
    let interrupts = 0;
    const provider = {
        complete: (_request, { signal }) => {
            signals.push(signal);
            return new Promise((resolve) => pending.push(resolve));
        },
    };
    const actions = Array.from({ length: 4 }, (_, i) =>
        f.action("bash", { command: `owned-${i}` }),
    );
    const attempts = actions.map((action) =>
        m.admit(action, decision(action, "ask", "review"), {
            provider,
            trustedAuthorization: "",
            onInterrupt: () => interrupts++,
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 3; i++) {
        pending[i]('{"outcome":"deny"}');
        await new Promise((resolve) => setImmediate(resolve));
    }
    pending[3]('{"outcome":"allow"}');
    const results = await Promise.all(attempts);
    expect(interrupts).toBe(1);
    expect(results.every((result) => !result.isAllowed)).toBeTruthy();
    expect(signals[3].aborted).toBe(true);
    await m.settle();
});
test("[audit] structured review metadata is bounded and redacted without retaining requests", async (t) => {
    const f = await fixture(t),
        audit = new AuditLog(join(f.control, "audit.jsonl"), [f.secret]),
        action = f.action("bash", { command: "owned" });
    await audit.recordReview(action, {
        status: "denied",
        actionDigest: action.digest,
        contextDigest: "context",
        policyDigest: "policy",
        assessment: {
            risk_level: "high",
            user_authorization: "low",
            outcome: "deny",
            rationale: `token=private-value ${f.secret} ${"long ".repeat(1000)}`,
        },
    });
    await audit.flush();
    const record = JSON.parse((await readFile(audit.path, "utf8")).trim());
    expect(record.review.status).toBe("denied");
    expect(record.review.rationale.length <= 1000).toBeTruthy();
    expect(JSON.stringify(record).includes("private-value")).toBeFalsy();
    expect(JSON.stringify(record).includes(f.secret)).toBeFalsy();
    expect(record.args).toBe(undefined);
});
test("[grants] one-use is consumed once while session rules bind exact inputs/profile/revision/source", async (t) => {
    const f = await fixture(t),
        m = manager(),
        action = f.action("bash", { command: "npm test" });
    const first = await m.admit(
        action,
        decision(action, "ask", "review"),
        context("once"),
    );
    expect(first.isAllowed).toBe(true);
    expect(first.grant.scope).toBe("once");
    const next = f.action("bash", action.args);
    expect(
        (await m.admit(next, decision(next, "ask", "review"), context("deny")))
            .isAllowed,
    ).toBe(false);
    expect(
        (
            await m.admit(
                action,
                decision(action, "ask", "review"),
                context("session"),
            )
        ).isAllowed,
    ).toBe(true);
    expect(
        (await m.admit(next, decision(next, "ask", "review"), context("deny")))
            .isAllowed,
    ).toBe(true);
    for (const extra of [
        { source: "nested" },
        { policyRevision: "changed" },
        { cwd: f.outside },
        { args: { command: "npm install" } },
    ]) {
        const changed = f.action("bash", extra.args ?? action.args, extra);
        expect(
            (
                await m.admit(
                    changed,
                    decision(changed, "ask", "review"),
                    context("deny"),
                )
            ).isAllowed,
        ).toBe(false);
    }
    expect(
        (
            await m.admit(
                next,
                decision(next, "deny", "hard", undefined, true),
                context("once"),
            )
        ).isAllowed,
    ).toBe(false);
    m.reset("new-session");
    expect(
        (await m.admit(next, decision(next, "ask", "review"), context("once")))
            .isAllowed,
    ).toBe(false);
});
test("[queue] concurrent UI requests serialize and queued cancellation/session replacement cannot cross-authorize", async (t) => {
    const f = await fixture(t),
        m = manager(),
        actions = [
            f.action("bash", { command: "a" }),
            f.action("bash", { command: "b" }),
        ],
        active = [],
        responses = [];
    const ui = {
        select: (action, _delta, { signal }) =>
            new Promise((resolve, reject) => {
                active.push(action.toolCallId);
                responses.push(resolve);
                signal.addEventListener("abort", () => reject(signal.reason), {
                    once: true,
                });
            }),
    };
    const one = m.admit(actions[0], decision(actions[0], "ask", "review"), {
        provider,
        ui,
        trustedAuthorization: "",
    });
    const caller = new AbortController();
    const two = m.admit(actions[1], decision(actions[1], "ask", "review"), {
        provider,
        ui,
        trustedAuthorization: "",
        signal: caller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toStrictEqual([actions[0].toolCallId]);
    caller.abort();
    responses[0]("once");
    expect((await one).isAllowed).toBe(true);
    expect((await two).isAllowed).toBe(false);
    expect(active.length).toBe(1);
    const three = m.admit(actions[0], decision(actions[0], "ask", "review"), {
        provider,
        ui,
        trustedAuthorization: "",
    });
    await new Promise((resolve) => setImmediate(resolve));
    m.reset("replacement");
    expect((await three).isAllowed).toBe(false);
    await m.settle();
});
test("[queue] approval deadline preserves milliseconds at the actual dialog and denies on expiry", async (t) => {
    const f = await fixture(t),
        clock = new ControlledClock(),
        m = manager({ clock, approvalTimeoutMs: 317 }),
        action = f.action("bash", { command: "a" });
    let finalOptions;
    const pending = m.admit(action, decision(action, "ask", "review"), {
        provider,
        ui: {
            select: (_action, _delta, options) => {
                finalOptions = options;
                return new Promise(() => {});
            },
        },
        trustedAuthorization: "",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(finalOptions.timeoutMs).toBe(317);
    clock.advance(316);
    expect(finalOptions.signal.aborted).toBe(false);
    clock.advance(1);
    expect((await pending).isAllowed).toBe(false);
    expect(finalOptions.signal.aborted).toBe(true);
});
test("[persistence] persistent rules require explicit UI selection, atomic save and successful compensation", async (t) => {
    const f = await fixture(t),
        path = join(f.control, "grants.json"),
        persistence = new FileGrantPersistence(path),
        m = manager({ persistence }),
        action = f.action("bash", { command: "a" });
    await m.initialize();
    expect(
        (
            await m.admit(action, decision(action, "ask", "review"), {
                provider,
                trustedAuthorization: "",
            })
        ).isAllowed,
    ).toBe(false);
    expect(
        (
            await m.admit(
                action,
                decision(action, "ask", "review"),
                context("persistent"),
            )
        ).isAllowed,
    ).toBe(true);
    const saved = await persistence.load();
    expect(saved.length).toBe(1);
    expect(saved[0].scope).toBe("persistent");
    expect(
        (await readdir(f.control)).filter((x) => x.endsWith(".tmp")).length,
    ).toBe(0);
    const restored = manager({ persistence });
    await restored.initialize();
    restored.reset(action.sessionId);
    expect(
        (
            await restored.admit(
                f.action("bash", action.args),
                decision(f.action("bash", action.args), "deny", "stale"),
                context("deny"),
            )
        ).isAllowed,
    ).toBe(false);
    const call = f.action("bash", action.args);
    expect(
        (
            await restored.admit(
                call,
                decision(call, "ask", "review"),
                context("deny"),
            )
        ).isAllowed,
    ).toBe(true);
    const caller = new AbortController(),
        snapshots = [];
    const failed = manager({
        persistence: {
            load: async () => [],
            save: async (grants) => {
                snapshots.push(grants);
                if (grants.length) caller.abort();
            },
        },
    });
    expect(
        (
            await failed.admit(action, decision(action, "ask", "review"), {
                ...context("persistent"),
                signal: caller.signal,
            })
        ).isAllowed,
    ).toBe(false);
    expect(snapshots[0].length).toBe(1);
    expect(snapshots[1].length).toBe(0);
    const broken = manager({
        persistence: {
            load: async () => [],
            save: async () => {
                throw new Error("disk full");
            },
        },
    });
    expect(
        (
            await broken.admit(
                action,
                decision(action, "ask", "review"),
                context("persistent"),
            )
        ).isAllowed,
    ).toBe(false);
});
test("[audit] nonempty success/denial/failure population omits content and redacts synthetic markers", async (t) => {
    const f = await fixture(t),
        path = join(f.control, "audit.jsonl"),
        audit = new AuditLog(path, [f.secret]),
        action = f.action("write", { path: "a", content: f.secret });
    for (const outcome of ["allowed", "denied", "failed"])
        await audit.record(action, "execution", `${outcome} ${f.secret}`);
    await audit.flush();
    const content = await readFile(path, "utf8");
    expect(content.trim().split("\n").length).toBe(3);
    expect(content.includes(f.secret)).toBeFalsy();
    expect(content.includes('"args"')).toBeFalsy();
    expect(
        redact(
            "token=private password=secret Bearer abcdef SYNTHETIC_SECRET_MARKER",
        ),
    ).toBe("token=[REDACTED] password=[REDACTED] Bearer [REDACTED] [REDACTED]");
});
