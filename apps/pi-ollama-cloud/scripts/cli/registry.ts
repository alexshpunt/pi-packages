import { authFeature } from "./auth.ts";
import { budgetsFeature } from "./budgets.ts";
import { catalogFeature } from "./catalog.ts";
import { coreFeature } from "./core.ts";
import { generatedFeature } from "./generated.ts";
import { modelsFeature } from "./models.ts";
import { renderFeature } from "./render.ts";
import { sharingFeature } from "./sharing.ts";
import { usageFeature } from "./usage.ts";
import type { VerificationFeature } from "./verification.ts";
import { webFeature } from "./web.ts";

// Static imports, deferred access: the core diagnostic also exercises the CLI runner.
export const DIAGNOSTICS: { id: string; name: string; feature: () => VerificationFeature }[] = [
  { id: "01-core-cli", name: "공용 경로·CLI", feature: () => coreFeature },
  { id: "02-auth", name: "인증 참조·취소", feature: () => authFeature },
  { id: "03-model-metadata", name: "모델 메타데이터·추론", feature: () => modelsFeature },
  { id: "04-catalog-cache", name: "카탈로그 복원·재시도", feature: () => catalogFeature },
  { id: "05-fetch-recovery", name: "페이지 실패·복구", feature: () => webFeature },
  { id: "06-tool-renderer", name: "결과 렌더러", feature: () => renderFeature },
  { id: "07-cache-budgets", name: "보관·반환량·이어 읽기", feature: () => budgetsFeature },
  { id: "08-cache-sharing", name: "동시 요청·프로세스 병합", feature: () => sharingFeature },
  { id: "09-usage-cancel", name: "사용량 갱신 취소", feature: () => usageFeature },
  { id: "10-generators", name: "생성 데이터 트랜잭션", feature: () => generatedFeature },
];
export const MENU_CHOICES = [
  { name: "모델 목록 조회", value: "models" },
  { name: "모델 메타데이터·출처 조회 (공개 API)", value: "metadata" },
  { name: "모델을 선택해 1+1 채팅", value: "chat" },
  { name: "모델 ID를 직접 입력해 1+1 채팅", value: "manual" },
  { name: "기능별 검증 (오프라인)", value: "diagnostics" },
  { name: "전체 기능·배포물 검증 (오프라인)", value: "verify" },
  { name: "종료", value: "exit" },
];
