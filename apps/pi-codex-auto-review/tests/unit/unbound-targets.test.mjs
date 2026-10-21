import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ApprovalManager } from "../../dist/approvals.js";
import { AuditLog } from "../../dist/audit.js";
import { createAction, decision } from "../../dist/contracts.js";
import {
    isPackageCacheEligible,
    PackageApprovalStore,
    skillPackageApproval,
} from "../../dist/package-approvals.js";
import { PolicyEngine, validateSettings } from "../../dist/policy/index.js";
import { isReadOnlyReview } from "../../dist/review/read-only.js";
import { fixture } from "../harness/fixtures.mjs";

const WSL_BASH = "C:\\Windows\\System32\\bash.exe";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

/** An owned skill whose package version was approved earlier. */
async function approvedSkill(t, shell) {
    const f = await fixture(t);
    const skill = join(f.workspace, "skills", "owned");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: owned\n---\n");
    await writeFile(join(skill, "run.py"), "print('owned')\n");
    const store = new PackageApprovalStore(join(f.root, "packages.json"));
    const approval = await skillPackageApproval(
        "python skills/owned/run.py",
        f.workspace,
        shell,
    );
    expect(approval).toBeDefined();
    await store.remember(approval, "persistent", "session");
    const policy = new PolicyEngine(validateSettings({}), f.profile);
    let reviews = 0;
    const admit = async (tool, args) => {
        const action = createAction(
            {
                toolCallId: "call",
                tool,
                args,
                source: "model",
                cwd: f.workspace,
                sessionId: "session",
                policyRevision: policy.revision,
            },
            f.profile,
        );
        const result = await policy.evaluate(action);
        const admission = await new ApprovalManager({
            reviewTimeoutMs: 500,
            approvalTimeoutMs: 500,
            audit: new AuditLog(),
            packageApprovals: store,
        }).admit(action, result, {
            provider: {
                complete: async () => {
                    reviews++;
                    return '{"outcome":"deny","risk_level":"low","user_authorization":"unknown","rationale":"owned"}';
                },
            },
            trustedAuthorization: "",
            packageApproval: await skillPackageApproval(
                args.command,
                f.workspace,
                tool,
            ),
        });
        return { result, admission, reviews };
    };
    return { ...f, admit };
}

test("[package-approvals] an approved skill is reviewed again when a PowerShell redirect has no file location", async (t) => {
    const f = await approvedSkill(t, "powershell");
    const plain = await f.admit("powershell", {
        command: "python skills/owned/run.py",
    });
    expect(plain.result.unboundTargets).toBeUndefined();
    expect(plain.admission.isAllowed).toBe(true);
    expect(plain.reviews).toBe(0);
    for (const command of [
        "python skills/owned/run.py > Env:OWNED",
        "python skills/owned/run.py > 'out?.txt'",
    ]) {
        const reviewed = await f.admit("powershell", { command });
        expect(reviewed.result.kind, command).toBe("ask");
        expect(reviewed.result.unboundTargets, command).toStrictEqual([
            "write",
        ]);
        expect(isPackageCacheEligible(reviewed.result), command).toBe(false);
        expect(reviewed.admission.isAllowed, command).toBe(false);
    }
    expect((await f.admit("powershell", { command: "python skills/owned/run.py" })).reviews).toBe(2);
});

test.runIf(process.platform === "win32")("[package-approvals] WSL and Git Bash redirects without a Windows location are reviewed again", async (t) => {
    const f = await approvedSkill(t, "bash");
    for (const [shellPath, command] of [
        [WSL_BASH, "python skills/owned/run.py > /mnt/c/Users/owned/out.txt"],
        [WSL_BASH, "python skills/owned/run.py < /mnt/c/Users/owned/in.txt"],
        [GIT_BASH, "python skills/owned/run.py > /etc/owned.conf"],
    ]) {
        const before = (await f.admit("bash", { command: "python skills/owned/run.py", shellPath })).reviews;
        const reviewed = await f.admit("bash", { command, shellPath });
        expect(reviewed.result.kind, command).toBe("ask");
        expect(reviewed.result.unboundTargets?.length, command).toBe(1);
        expect(isPackageCacheEligible(reviewed.result), command).toBe(false);
        expect(reviewed.admission.isAllowed, command).toBe(false);
        expect(reviewed.reviews, command).toBe(before + 1);
    }
});

test("[unbound-targets] every consumer of an empty delta also checks unbound targets", async (t) => {
    const f = await fixture(t);
    const action = f.action("bash", { command: "cat notes.txt" });
    const ask = decision(action, "ask", "Review");
    const unbound = (targets) => ({ ...ask, unboundTargets: targets });
    expect(isPackageCacheEligible(ask)).toBe(true);
    for (const targets of [["read"], ["write"], ["read", "write"]])
        expect(isPackageCacheEligible(unbound(targets)), targets.join()).toBe(
            false,
        );
    // Read-only reuse treats unbound reads like reads outside the roots, never unbound writes.
    expect(isReadOnlyReview(action, unbound(["read"]))).toBe(true);
    expect(isReadOnlyReview(action, unbound(["write"]))).toBe(false);
    // A legacy custom provider cannot auto-approve scope it cannot see.
    const legacy = {
        complete: async () => '{"decision":"allow","reason":"owned"}',
    };
    const admit = (policy) =>
        new ApprovalManager({
            reviewTimeoutMs: 500,
            approvalTimeoutMs: 500,
            audit: new AuditLog(),
        }).admit(action, policy, {
            provider: legacy,
            trustedAuthorization: "",
        });
    expect((await admit(ask)).isAllowed).toBe(true);
    expect(await admit(unbound(["write"]))).toMatchObject({
        isAllowed: false,
        reason: "Legacy assessment cannot automatically increase permission",
    });
});
