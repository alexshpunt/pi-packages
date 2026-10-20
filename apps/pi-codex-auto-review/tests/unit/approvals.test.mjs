import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
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
        assert.equal(
            (
                await manager({ approvalPolicy }).admit(
                    action,
                    decision(action, "ask", "boundary"),
                    request,
                )
            ).isAllowed,
            false,
        );
    }
    assert.equal(reviews, 0);
    assert.equal(dialogs, 0);
    assert.equal(
        (
            await manager({ approvalsReviewer: "user" }).admit(
                action,
                decision(action, "ask", "boundary"),
                request,
            )
        ).isAllowed,
        true,
    );
    assert.equal(reviews, 0);
    assert.equal(dialogs, 1);
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
    assert.equal(
        lifecycle.record(action, "context", denied).shouldInterrupt,
        false,
    );
    assert.equal(
        lifecycle.record(action, "context", denied).shouldInterrupt,
        false,
    );
    assert.equal(
        lifecycle.record(action, "context", denied).shouldInterrupt,
        true,
    );
    assert.equal(lifecycle.signal.aborted, true);
    lifecycle.startTurn();
    assert.equal(lifecycle.signal.aborted, false);
    for (let i = 0; i < 10; i++) {
        assert.equal(
            lifecycle.record(action, "context", denied).shouldInterrupt,
            i === 9,
        );
        lifecycle.record(action, "context", {
            ...denied,
            status: "timed-out",
            failure: "timeout",
            reason: "timeout",
        });
    }
    assert.equal(lifecycle.recentDenials.length, 10);
    lifecycle.startTurn();
    for (let i = 0; i < 9; i++) {
        lifecycle.record(action, "context", denied);
        lifecycle.record(action, "context");
    }
    for (let i = 0; i < 50; i++) lifecycle.record(action, "context");
    assert.equal(
        lifecycle.record(action, "context", denied).shouldInterrupt,
        false,
    );
    assert.match(reviewFeedback(denied).message, /policy circumvention/);
    assert.match(
        reviewFeedback({ ...denied, status: "timed-out" }).message,
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
    assert.equal(m.lifecycle.signal.aborted, true);
    assert.equal(
        (
            await m.admit(
                userAction,
                decision(userAction, "allow", "owned"),
                denied,
            )
        ).isAllowed,
        true,
    );
    assert.equal(
        (
            await m.admit(
                modelAction,
                decision(modelAction, "allow", "owned"),
                denied,
            )
        ).isAllowed,
        false,
    );
    const caller = new AbortController();
    caller.abort();
    assert.equal(
        (
            await m.admit(userAction, decision(userAction, "allow", "owned"), {
                ...denied,
                signal: caller.signal,
            })
        ).isAllowed,
        false,
    );
    m.reset("another-session");
    assert.equal(
        (
            await m.admit(
                userAction,
                decision(userAction, "allow", "owned"),
                denied,
            )
        ).isAllowed,
        false,
    );
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
    assert.equal(initial.isAllowed, false);
    assert.ok(initial.denialId);
    const current = {
        sessionId: action.sessionId,
        contextId: reviewContext.contextId,
        cwd: action.cwd,
        policyRevision: action.policyRevision,
        permissionDigest: action.permissionDigest,
    };
    assert.throws(
        () =>
            m.lifecycle.authorizeRetry(initial.denialId, {
                ...current,
                contextId: "changed",
            }),
        /current context/,
    );
    m.lifecycle.authorizeRetry(initial.denialId, current);
    assert.equal(
        (
            await invoke(
                f.action("write", { ...action.args, content: "different" }),
            )
        ).isAllowed,
        false,
    );
    const exact = await invoke(f.action("write", action.args));
    assert.equal(exact.isAllowed, true);
    assert.deepEqual(exact.delta.writePaths, [join(f.outside, "sentinel.txt")]);
    assert.equal(
        (await invoke(f.action("write", action.args))).isAllowed,
        false,
    );
    assert.equal(
        requests.filter((request) =>
            request.context.items.some(
                (item) => item.source === "user-confirmation",
            ),
        ).length,
        1,
    );
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
    assert.equal(
        m.lifecycle.authorizeRetry(critical.denialId, current).assessment
            .risk_level,
        "critical",
    );
    assert.ok(
        m.lifecycle.consumeRetry(action, reviewContext.contextId),
        "An earlier critical label must not prevent a fresh assessment",
    );
    m.reset("new-session");
    assert.equal(m.lifecycle.recentDenials.length, 0);
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
    assert.equal(interrupts, 1);
    assert.ok(results.every((result) => !result.isAllowed));
    assert.equal(signals[3].aborted, true);
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
    assert.equal(record.review.status, "denied");
    assert.ok(record.review.rationale.length <= 1000);
    assert.ok(!JSON.stringify(record).includes("private-value"));
    assert.ok(!JSON.stringify(record).includes(f.secret));
    assert.equal(record.args, undefined);
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
    assert.equal(first.isAllowed, true);
    assert.equal(first.grant.scope, "once");
    const next = f.action("bash", action.args);
    assert.equal(
        (await m.admit(next, decision(next, "ask", "review"), context("deny")))
            .isAllowed,
        false,
    );
    assert.equal(
        (
            await m.admit(
                action,
                decision(action, "ask", "review"),
                context("session"),
            )
        ).isAllowed,
        true,
    );
    assert.equal(
        (await m.admit(next, decision(next, "ask", "review"), context("deny")))
            .isAllowed,
        true,
    );
    for (const extra of [
        { source: "nested" },
        { policyRevision: "changed" },
        { cwd: f.outside },
        { args: { command: "npm install" } },
    ]) {
        const changed = f.action("bash", extra.args ?? action.args, extra);
        assert.equal(
            (
                await m.admit(
                    changed,
                    decision(changed, "ask", "review"),
                    context("deny"),
                )
            ).isAllowed,
            false,
        );
    }
    assert.equal(
        (
            await m.admit(
                next,
                decision(next, "deny", "hard", undefined, true),
                context("once"),
            )
        ).isAllowed,
        false,
    );
    m.reset("new-session");
    assert.equal(
        (await m.admit(next, decision(next, "ask", "review"), context("once")))
            .isAllowed,
        false,
    );
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
    assert.deepEqual(active, [actions[0].toolCallId]);
    caller.abort();
    responses[0]("once");
    assert.equal((await one).isAllowed, true);
    assert.equal((await two).isAllowed, false);
    assert.equal(active.length, 1);
    const three = m.admit(actions[0], decision(actions[0], "ask", "review"), {
        provider,
        ui,
        trustedAuthorization: "",
    });
    await new Promise((resolve) => setImmediate(resolve));
    m.reset("replacement");
    assert.equal((await three).isAllowed, false);
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
    assert.equal(finalOptions.timeoutMs, 317);
    clock.advance(316);
    assert.equal(finalOptions.signal.aborted, false);
    clock.advance(1);
    assert.equal((await pending).isAllowed, false);
    assert.equal(finalOptions.signal.aborted, true);
});
test("[persistence] persistent rules require explicit UI selection, atomic save and successful compensation", async (t) => {
    const f = await fixture(t),
        path = join(f.control, "grants.json"),
        persistence = new FileGrantPersistence(path),
        m = manager({ persistence }),
        action = f.action("bash", { command: "a" });
    await m.initialize();
    assert.equal(
        (
            await m.admit(action, decision(action, "ask", "review"), {
                provider,
                trustedAuthorization: "",
            })
        ).isAllowed,
        false,
    );
    assert.equal(
        (
            await m.admit(
                action,
                decision(action, "ask", "review"),
                context("persistent"),
            )
        ).isAllowed,
        true,
    );
    const saved = await persistence.load();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].scope, "persistent");
    assert.equal(
        (await readdir(f.control)).filter((x) => x.endsWith(".tmp")).length,
        0,
    );
    const restored = manager({ persistence });
    await restored.initialize();
    restored.reset(action.sessionId);
    assert.equal(
        (
            await restored.admit(
                f.action("bash", action.args),
                decision(f.action("bash", action.args), "deny", "stale"),
                context("deny"),
            )
        ).isAllowed,
        false,
    );
    const call = f.action("bash", action.args);
    assert.equal(
        (
            await restored.admit(
                call,
                decision(call, "ask", "review"),
                context("deny"),
            )
        ).isAllowed,
        true,
    );
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
    assert.equal(
        (
            await failed.admit(action, decision(action, "ask", "review"), {
                ...context("persistent"),
                signal: caller.signal,
            })
        ).isAllowed,
        false,
    );
    assert.equal(snapshots[0].length, 1);
    assert.equal(snapshots[1].length, 0);
    const broken = manager({
        persistence: {
            load: async () => [],
            save: async () => {
                throw new Error("disk full");
            },
        },
    });
    assert.equal(
        (
            await broken.admit(
                action,
                decision(action, "ask", "review"),
                context("persistent"),
            )
        ).isAllowed,
        false,
    );
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
    assert.equal(content.trim().split("\n").length, 3);
    assert.ok(!content.includes(f.secret));
    assert.ok(!content.includes('"args"'));
    assert.equal(
        redact(
            "token=private password=secret Bearer abcdef SYNTHETIC_SECRET_MARKER",
        ),
        "token=[REDACTED] password=[REDACTED] Bearer [REDACTED] [REDACTED]",
    );
});
