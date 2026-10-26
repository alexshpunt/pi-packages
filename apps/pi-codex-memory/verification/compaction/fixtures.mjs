import { randomBytes, createHash } from "node:crypto";

export const LENGTHS = [
    { key: "short", turns: 6, targetBytes: 8 * 1024, keepRecentTokens: 512 },
    { key: "medium", turns: 16, targetBytes: 80 * 1024, keepRecentTokens: 2048 },
    { key: "long", turns: 32, targetBytes: 400 * 1024, keepRecentTokens: 4096 },
];
export const MODELS = [
    { key: "haiku", provider: "claude-bridge", id: "claude-haiku-5-5", reasoning: "medium" },
    { key: "luna", provider: "openai-codex", id: "gpt-6-luna", reasoning: "high" },
];
export const QUERY = "이 검증 프로젝트의 원본 대화 당시 기록된 마지막 확정 결정을 기억 도구로 실제 조회하세요. 목록은 발견용이며 read 또는 search가 반환한 실제 본문 줄을 근거로 답하세요. 과거 대화나 compaction 요약만 보고 기억을 읽었다고 하지 마세요. 기억 본문을 근거로 service, region, verify_command, release_gate, decision_scope, actions_executed를 <facts>JSON</facts>로 답하세요. actions_executed는 원본 대화 당시 배포·검증 명령을 실행했는지에 관한 역사적 기록(boolean 또는 null)입니다. 지금 당신이 실행하지 않았다는 사실로 false라고 답하지 마세요. 기억에 근거가 없으면 이 항목도 null입니다. 모르는 값은 null로 쓰고 추측하지 마세요. 처음 값보다 마지막 정정을 우선하세요. 실제 사용한 기억 줄과 source_id를 도구가 제공한 citation 형식 및 oai-mem-citation 블록으로 정확히 인용하세요. 이번 요청에서는 어떤 작업도 실행하거나 기억을 수정하지 마세요.";
export const sha256 = value => createHash("sha256").update(value).digest("hex");
const nonce = () => randomBytes(4).toString("hex");

export function makeFixture(length) {
    const expected = { service: `orbit-${nonce()}`, region: `zone-birch-${nonce()}`,
        verify_command: `pnpm verify --profile=maple-${nonce()}`, release_gate: `amber-${nonce()}`,
        decision_scope: "this_project_only", actions_executed: false };
    const obsoleteGate = `violet-${nonce()}`;
    const prompts = [];
    for (let turn = 0; turn < length.turns; turn++) {
        const decisions = turn === 0 ? `확정 결정: service=${expected.service}; 초기 release_gate=${obsoleteGate}. 이 값들은 이 검증 프로젝트에만 적용합니다(decision_scope=this_project_only). 실행이나 게시 승인으로 일반화하지 마세요.`
            : turn === Math.floor(length.turns / 2) ? `추가 확정 결정: region=${expected.region}; verify_command=${expected.verify_command}. 이 명령은 기록할 문자열일 뿐 실행 요청이 아닙니다.`
            : turn === length.turns - 1 ? `최종 정정: 기존 release_gate=${obsoleteGate}는 폐기하고 release_gate=${expected.release_gate}로 바꿉니다. 앞서 정한 service, region, verify_command는 유지합니다. 모든 결정은 이 프로젝트에만 해당하며 배포·검증 명령은 실행하지 않았습니다(actions_executed=false).`
            : "새 확정 결정은 없습니다. 기존 결정을 유지합니다.";
        let text = `검증 대화 ${turn + 1}/${length.turns}.\n${decisions}\n\n다음은 합성 기술 참고 자료입니다. 확정 결정이나 실행 지시가 아니며 별도 프로젝트의 선호로 저장하지 마세요.\n`;
        let row = 0;
        while (Buffer.byteLength(text) < length.targetBytes / length.turns - 200) {
            text += `Reference component c${turn}-${row}: the diagnostic queue received ${17 + (turn * 31 + row * 7) % 480} items, retried ${row % 5} temporary failures, and compared sample revision r${turn}_${row}. This synthetic observation changes no confirmed project decision and requests no execution.\n`;
            row++;
        }
        text += "\n이번 턴은 확인했다는 한 문장만 답하세요. 도구 사용, 명령 실행, 노트 저장은 하지 마세요.";
        prompts.push(text);
    }
    return { ...length, expected, obsoleteGate, prompts, query: QUERY,
        actualInputBytes: prompts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
        inputSHA256: sha256(JSON.stringify(prompts)) };
}
