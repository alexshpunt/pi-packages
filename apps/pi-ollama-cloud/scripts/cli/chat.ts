import { CHAT_PROMPT, completeOllamaChat } from "../../src/pi/chat.ts";

export async function runChat(modelId: string, signal: AbortSignal): Promise<void> {
  console.log(`\n모델: ${modelId}\n질문: ${CHAT_PROMPT}\n응답 대기 중...`);
  const result = await completeOllamaChat(modelId, signal);
  console.log(`응답:\n${result.answer}\n`);
  if (result.truncated) console.warn("출력 토큰 한도에 도달해 응답이 잘렸을 수 있습니다.");
}
