# 03. Prompt Runtime QA 원본 진단

**파일**: `src/ai/chat/runtime/prompt-runtime.ts` (1,105줄)
**연계**:
- `src/ai/chat/runtime/openai-runtime.ts` (L459~552)
- `src/ai/utils/prompt-builder.ts` (L549~805)
- `src/ai/engines/chat-engine.ts` (L890~1020, L1675~1745)

---

## 🚨 단독 최대 품질 저하 원인 발견

**6개 호출 전부에서 `conversationTurns` 전달 누락 확인.**

---

## 1. 런타임 수명주기

세션 시작/종료 훅이 없다. `runPromptRuntime`는 순수 stateless 함수라 "세션 warm-up, teardown, per-turn eviction" 단계가 모두 chat-engine으로 올라가 있다.

문제는 런타임 입장에서 "이번이 몇 번째 턴인지"를 `turnIndex`로만 받는데 (L458), 첫턴 감지 외엔 수명주기 정보를 쓰지 않아 **세션 누적 상태(이전 tool call 결과, previous_response_id)**가 프롬프트 조립에 반영되지 않는다.

`previous_response_id` / `conversation_id`는 `openai-runtime.ts:585-589`에서만 소비되고 prompt-runtime은 무관.

## 2. System prompt 재계산 빈도

**매 턴 전체 재계산**. 캐시는 `PromptBuilder`의 `CachingEngine.buildKeyFromPayload` (prompt-builder.ts L751-762)에서만 걸리는데, key에 `memoryHash`, `turnIntent`, `responseHint`, `tone`이 들어가 사실상 매 턴 miss.

`designMode`면 `cached && !designMode` 조건(L765)으로 아예 bypass.

결과: system core가 매 턴 수 KB씩 재합성되며, 스킬 블록(pgvector retrieval 200–500ms — L535 주석)도 DEEP/slash일 때마다 재호출. OpenAI 쪽 prompt caching 힌트(prefix 고정)와도 안 맞음.

## 3. 메시지 이력 관리 ★★★

**치명적 단절**.

- chat-engine L890-921에서 `MessageEngine.listMessages(threadId).slice(-historyDepth)`로 12~30턴 history를 가져와 `conversationTurns`에 실어 PromptRuntime에 넘긴다.
- PromptRuntime의 `PromptRuntimeMeta`에도 `conversationTurns` 필드가 정의돼 있다(L64-67).
- **그런데 prompt-runtime.ts 내부 6개 `PromptBuilder.buildChatPrompt` 호출 중 어디에서도 `conversationTurns`를 builder meta로 넘기지 않는다** (L843, L868, L886, L908, L937, L1019).
- PromptBuilder L778-805는 `safeMeta.conversationTurns`가 오면 `[RECENT CONVERSATION]` 블록을 만들도록 돼 있는데, prompt-runtime이 forward를 빠뜨려 **실제로는 항상 undefined → 대화 이력 블록이 영영 안 만들어진다**.

**이게 단독 최대 품질 저하 원인이다.**

Token budget은 `HARD_REF_TOKEN_CAP=16_000`으로 reference만 제한.

## 4. Prompt composition 순서

6개 분기(FAST×4 sub + implementation + DEEP + NORMAL)에서 필드 전달이 서로 다르다.

- FAST vision path (L843-863)는 `attachments`/`evidenceSignals`를 주지만
- FAST DEEP-question path (L868-884)는 `attachments`를 빼먹는다.
- NORMAL path (L1019)만 `instanceId`, `responseDensityHint`, `turnIntent`, `tone`를 완전하게 넘기고
- implementation path (L937)는 `attachments`는 있지만 `depthHint`, `responseHint` 누락.

**우선순위 충돌**: `meta.constraints`가 L376, L442, L826 세 번 mutate되는데 마지막 `FILE_INTELLIGENCE` 블록(L826)은 `effectiveConstraints` 계산(L481) 이후라 **languageConstraint와 같이 엮이지 않고 builder로 전달 안 됨**.

## 5. Multi-turn 상태 관리

- **이전 tool call 결과**: `conversationTurns` 미전달로 `toolContext` (builder L796-800) 블록도 같이 소실.
- **이전 assistant reasoning 유지**: reasoning summary는 openai-runtime L491에서 "⟦REASONING_BLOCK⟧ injection removed (SSOT v4)" 주석대로 **삭제됨**. DEEP 재방문 시 직전 턴 reasoning이 반영 안 된다.
- **사용자 의도 추적**: `turnIntent`/`continuityAllowed`/`anchorConfidence`가 오지만 context-runtime에서 한 번만 평가되고 prompt-runtime은 raw로 builder에 forward.
- `conversationId`/`previousResponseId` (openai-runtime L585)는 chat-engine에서만 연결되며 prompt-runtime은 모름.

## 6. 에러 fallback

유일한 가드는 L1077-1084 "빈 prompt면 throw".

그러나 **PromptBuilder 내부 캐시 히트(L764)**로 이전 사용자 프롬프트가 재사용될 수 있는데, 새 사용자 메시지가 cache key의 `message` 필드에 들어가니 보통은 OK지만 `memoryHash` 충돌 시 과거 턴 프롬프트가 그대로 반환될 수 있다.

또 L542 `mdResult.rows[]` 이후 어떤 에러도 `.catch(() => {})`로 삼켜 silent degradation — memory-md, connectors, skills가 하나라도 실패하면 시스템 프롬프트가 **조용히 빈약해진다** (경고 로그 없음).

## 7. 테스트 가능성

- **Non-deterministic**: `Date.now()` 로깅(L341, L534, L591, L1089), `Promise.all` 4-way race(L539), `simpleHash` 기반 cache key.
- **Seed**: `openai-runtime.ts:594`만 optional seed. Responses API는 temperature도 무시(L591 주석)되는데 temperature/top_p를 여전히 설정(L427-437) — seed 고정해도 재현성 없음.
- **Snapshot**: 런타임이 최종 `message` 문자열만 뱉고 composition 구조를 노출 안 해 golden test 불가.

## 8. ChatGPT 웹 대비 누락 요소

1. **Prior assistant turns을 messages[] 배열로** 넘기지 않음 — 전부 system prompt 안 문자열로 말아넣음 (openai-runtime L459-552는 system 1개 + user 1개). 멀티턴 coherence가 크게 떨어짐.
2. **Canvas/artifact editing** 연속성 없음. builder L808-822의 artifactBlock도 conversationTurns 누락으로 죽음.
3. **Memory read/write 피드백** — 웹은 "Memory updated" 인지 신호를 주지만 여기는 `memoryMdBlock` 주입만 하고 write-back 루프 없음.
4. **Regenerate/branch**: `previousResponseId`는 있지만 branch-from-message API 없음.
5. **Tool hand-off 연속성**: Responses API의 `tool_call_id → tool_result` 체인이 다음 턴 prompt에 자동 포함되지 않음.

## 9. 품질 저하 근본 원인 TOP 5

### 1. ★★★★★★ `conversationTurns` forward 누락 (CRITICAL)
`prompt-runtime.ts` **L843/L868/L886/L908/L937/L1019 6개 분기 전수**. chat-engine L1687에서 받은 history가 builder로 전달되지 않아 **매 턴 "새 세션처럼" 동작**. 유일하게 가장 큰 원인.

### 2. 사용자 메시지를 single-user-turn으로만 주입
`openai-runtime.ts` L545-551. `messages=[system, user]` 1턴 구조라 모델이 assistant 과거 답변을 못 봄.

### 3. `meta.constraints` post-mutation 누락
`prompt-runtime.ts` L826의 FILE_INTELLIGENCE constraint는 L481 `effectiveConstraints` 계산 뒤에 mutate돼서 **builder에 전달 안 됨**. L441 `!hasImage` constraint도 같은 구조지만 L481 이전이라 살아남음 — 순서 혼재.

### 4. Silent catch-all
L544/546/550/553 `.catch(() => ...)` 체인. skills/memory-md/connectors 전체가 조용히 빠질 수 있는데 L518 한 줄 warn 외엔 관측 불가. 품질 들쭉날쭉한 체감의 원인.

### 5. Reasoning summary 비주입 + seed 무의미
`openai-runtime.ts` L492 "⟦REASONING_BLOCK⟧ injection removed", L591 "Responses API ignores temperature". DEEP 모드에서 직전 reasoning을 이어받지 못하고 sampling 파라미터는 설정돼도 효과 없어서 재현성/연속성 둘 다 깨짐.

## 수정 우선순위

- **P0**: #1 — 6개 `buildChatPrompt` 호출에 `conversationTurns: meta.conversationTurns` 한 줄씩 추가. 즉시 체감 개선.
- **P0**: #3 — L826 mutation을 L481 앞으로 이동하거나 `guardedConstraints`에 재주입.
- **P1**: #4 — catch 블록에 명시 warn + telemetry counter.
- **P1**: #2 — history를 `input` 배열에 `role:"assistant"`/`role:"user"`로 풀어 넣도록 openai-runtime 재설계 (또는 `previous_response_id` 강제 연결).
- **P2**: #5 — reasoning carry-over 복구, seed 고정 경로 재검토.
