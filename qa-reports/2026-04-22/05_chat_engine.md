# 05. Chat Engine QA 원본 진단

**주 파일**: `src/ai/engines/chat-engine.ts` (2,349줄)

**연계**:
- `src/ai/chat/chat-engine-router.ts`
- `src/ai/chat/legacy/legacy-chat-engine-adapter.ts`
- `src/ai/chat/paths/chat-engine-guide-path.ts` (6줄, stub)
- `src/ai/chat/paths/chat-{fast,normal,deep,search,research}-path.ts`
- `src/ai/chat/runtime/openai-runtime.ts`
- `src/ai/chat/runtime/prompt-runtime.ts`
- `src/ai/chat/runtime/context-runtime.ts`
- `src/ai/execution/execution-engine.ts` (실제 LLM 호출 지점)
- `src/ai/engines/adaptive-router.ts` (미연결)
- `src/docs/engine/chat-engine.md` (TODO 상태)

---

## 1. 엔진 흐름 (pipeline)

요청은 `chat-engine-router.ts:11` → `paths/*` → `legacy-chat-engine-adapter.ts:58` → `ChatEngine.generateResponse`(`chat-engine.ts:497`) 순으로 단일 경로로 수렴한다.

generateResponse 내부 단계:
1. SSOT guard
2. safety
3. path/mode 확정
4. OpenAI tool pre-pass
5. Mega Group A 병렬(history+persona+cross-memory+style+userPrefs+context)
6. failureSurface/selfCorrection
7. PromptRuntime
8. memory candidate/dedup/commit
9. 반환

**LLM 호출은 여기서 안 일어남** — 최종 스트림/텍스트 생성은 `execution-engine.ts:505,1568`의 `runOpenAIRuntime`이 담당.

즉 chat-engine은 "프롬프트 컴파일러"이고 응답 생성은 ExecutionEngine이다.

문서 `/tmp/yua-backend/src/docs/engine/chat-engine.md`는 TODO 템플릿 상태로 이 이원 구조가 명시되지 않음 — 신규 개발자가 "후처리/재주입 루프가 없어 보이는데?" 오해할 여지가 크다.

## 2. 라우팅 로직

`chat-engine-router.ts:11-28`은 `ctx.req.outMode` 단일 값으로 FAST/NORMAL/DEEP/SEARCH/RESEARCH/ENGINE_GUIDE 6개 path에 switch 분기.

**질문 내용 기반 분류가 아니라 상위(Decision/UI)가 정한 outMode를 그대로 소비**.

모델 선택은 `openai-runtime.ts:307-314`에서 mode→modelId 정적 테이블. FAST만 gpt-5.4-mini, 나머지 전부 gpt-5.4 하드코딩.

Path 파일 6개 중 5개(fast/normal/deep/search/research/engine-guide) 모두 `runLegacyChat`으로 forward — 분기의 유일한 차이는 `thinkingProfile + computePolicy`뿐.

**진정한 의미의 라우팅이 아니라 컴퓨트 프리셋 selector다.**

## 3. Path guide

`chat-engine-guide-path.ts:1-6`은 6줄짜리 shim — `runLegacyChat(ctx)` 호출만 하고 overrides조차 없음.

"대화 흐름 가이드 / 상태 머신"이 아니라 **ENGINE_GUIDE outMode가 왔을 때 기본 경로로 우회시키는 placeholder**.

실제 가이드 로직은 존재하지 않음. 설계 의도가 "엔진 소개 모드"라면 미구현이고, placeholder라면 제거하거나 전용 system prompt를 실어야 한다.

## 4. Legacy adapter

`legacy-chat-engine-adapter.ts:21-87`은 이름과 달리 **현 유일한 진입 경로**다.

router가 나눈 path 6개가 모두 여기로 모여 `Profiler.load(userType)` → `ChatEngine.generateResponse(content, persona, meta)` 호출.

즉 "legacy"는 오해의 소지가 있는 네이밍 — 실제로는 "path→engine bridge"의 역할.

코드 부채로 남아있는 것이 아니라 **현역이며, 이름만 legacy**.

스트리밍 분기 `answer: meta.stream === true ? "" : ...`(line 78-82)로 stream일 때 빈 문자열 반환하고 실제 토큰은 ExecutionEngine이 SSE로 흘린다.

**네이밍 즉시 교정 필요.**

## 5. Streaming 전파

ChatEngine 자체는 토큰 스트리밍에 **직접 관여하지 않는다**.

- `StreamEngine.publish`(`chat-engine.ts:188,1864,2042,2310`)로 activity/memory/suggestion 같은 **메타 이벤트**만 SSE에 흘리고,
- 실제 text_delta는 `openai-runtime.ts:795-810`에서 emit되어 ExecutionEngine이 소비 후 UI로 forward.

**문제**:
- (a) `meta.stream===true`일 때 chat-engine은 `prompt`만 빌드하고 return하는데,
- (b) adapter(line 78)는 stream이면 `answer:""` 반환 — **prompt가 사용되는 지점이 chat-engine 레벨에서는 안 드러남**.
- 즉 prompt를 받아 ExecutionEngine이 재호출하는 구조가 코드만 봐서는 추적 불가.

## 6. 에러 / timeout / partial output

- `openai-runtime.ts:619-624`: 스트리밍에 90초 wall-clock + user abort signal 결합. **합리적**.
- ChatEngine 전체가 **단일 try/catch**(`chat-engine.ts:502-2118`)로 감싸여 있고 `catch`에서 그냥 `throw err` 재전파(line 2118). 부분 복구/재시도 없음.
- MegaGroupA 내부 각 sub-task는 개별 try/catch로 best-effort 처리 — OK.
- **retry/backoff 없음**: OpenAI tool pre-pass(line 765 `for (let iter = 0; iter < 2; iter++)`)는 "2회 iteration"이지 실패 재시도가 아님. 5xx, rate limit 발생 시 즉시 throw.
- Tool 실행 중간 실패: `runVerifierLoop`(line 1226)가 pass/fail만 판정하고 `verified:false`면 trustedFact 제외. **LLM에게 "이 tool 실패" 알려주는 재주입 루프 없음**.
- SSE partial output 도중 abort: runtime에서 `signal?.aborted && break`(line 651) 처리되나 ChatEngine 레벨의 checkpoint/resume 불가.

## 7. Tool / function calling 통합

**이중 구조라 혼란**.

- **(A) Pre-pass**: `chat-engine.ts:755-867` `OpenAI.responses.create(tool_choice:"auto")`로 최대 2회 루프 돌려 context 수집 → `toolRuntimeContext`로 PromptRuntime에 주입.
- **(B) Main tool plan**: `buildToolExecutionPlan`(line 1191) → `dispatchYuaExecutionPlan` → `runVerifierLoop` → `trustedFacts` 생성.
- **(C) 실제 응답 생성 시 tool**: ExecutionEngine이 다시 tool 구성.

**문제점**:
1. 스트리밍일 때 pre-pass 스킵(line 763 `skipStreamingToolPrepass = meta.stream===true`) — 같은 질문이 stream/non-stream에 따라 다른 맥락을 받음. 일관성 파괴.
2. tool 결과 실패 시 모델에게 "retry this with different args" 재주입 루프 없음.
3. pre-pass와 main plan 사이 중복/충돌 방지 로직 부재.

## 8. Observability

- `console.log("[DEBUG]...")` 난무(chat-engine.ts에만 15+곳), traceId는 모든 로그에 일관 주입 안 됨.
- `ReasoningSessionController`(line 587-595, 722-737, 1269-1275, 1746-1753)가 stage별 trace를 기록하나 **decision/tool_plan/prompt_runtime** 3 stage만 있고 memory/safety/dedup 미커버.
- `[PERF][MEGA_GROUP_A]`, `[PERF][PROMPT_RUNTIME]` latency 측정은 있으나 OpenTelemetry/Datadog 같은 구조화 tracing 없음.
- `writeRawEvent`(`openai-runtime.ts:28`)는 raw OpenAI event dump용 — 개발 전용.
- Production용 metric/alert 파이프라인 부재.

## 9. ChatGPT 웹 대비 구조적 약점

ChatGPT 웹은 "질문→자동 모드 선택→tool 자동 호출→응답"이 한 사이클에서 일어난다.

YUA는 **outMode가 상위(Decision/UI)에서 미리 결정**되어 들어와야 router가 동작(`chat-engine-router.ts:12`). 즉 모드 자동 전환은 DecisionOrchestrator 책임이지 chat-engine 책임이 아님 — 여기까지는 합리적 분리.

**약점**:
1. path 6개가 모두 same engine에 thinkingProfile만 바꿔 보내므로 **"질문 타입에 특화된 pipeline"이 없다** (search-path는 search 특화 ranking 없음, research-path는 research 특화 citation 없음, 전부 default).
2. pre-pass tool + main tool + execution tool **3중 tool layer**가 따로 놀고 한 질문 내 tool call→결과→재질문 루프를 모델이 주도하지 못한다.
3. model=gpt-5.4 하드코딩(`openai-runtime.ts:307`)이라 질문 복잡도에 따른 모델 다운그레이드/업그레이드가 런타임에 불가능.

## 10. 품질 저하 원인 TOP 5

### 1. `chat-engine.ts:763` 스트리밍 tool pre-pass 스킵
stream/non-stream 응답 품질이 체계적으로 달라진다. 사용자는 항상 stream을 쓰므로 non-stream 경로의 context 풍부함이 운영에서 낭비됨.
**개선**: pre-pass 결과를 thread-level cache에 저장하고 stream에서도 참조하거나, ExecutionEngine의 tool layer와 일원화.

### 2. `chat-engine.ts:2111-2118` 전역 catch 후 재throw
2300줄 파이프라인 어디서 터져도 전체 실패. ContextRuntime, PromptRuntime, memory 중 하나만 실패해도 응답 0개.
**개선**: 단계별 graceful degrade (e.g. ContextRuntime 실패 시 빈 context로 진행), memory/dedup/style은 이미 best-effort인 점을 prompt까지 확장.

### 3. `openai-runtime.ts:307-314` 모델 정적 테이블
FAST=mini, 그 외 전부 gpt-5.4. DEEP에도 mini를 못 쓰고, 간단 질문에 gpt-5.4를 강제 사용. 비용·지연 모두 손해.
**개선**: reasoning.depthHint + toolGate + input length 기반 adaptive model resolver. `adaptive-router.ts`가 이미 존재(`/tmp/yua-backend/src/ai/engines/adaptive-router.ts`)하나 resolveRuntimeModelId와 연결 안 됨.

### 4. `chat-engine.ts:534-538` SSOT violation throw
`meta.reasoning`/`meta.mode` 누락 시 throw. Decision이 실패해 meta가 비면 chat-engine도 즉사. 방어적 기본값 대신 hard fail.
**개선**: fallback reasoning(intent:"ask", depth:"normal", confidence:0.5) + mode:"NORMAL"로 degrade 후 `[SSOT_VIOLATION]` 로그만.

### 5. `chat-engine.ts:1675-1745` PromptRuntime 호출의 40+ 필드 meta 패키징
하나라도 누락되면 prompt가 silent하게 block 하나씩 빠짐(예 line 1714-1719 userId 주석). 타입은 `any` 캐스팅(`(meta as any).uiLocale` line 1735) 포함해 drift 위험 큼.
**개선**: `PromptRuntimeMeta` 타입 strict 화 + required/optional 명확화 + 누락 시 warn log 일괄 발생시키는 validator.

## 추가 발견

- `chat-engine.ts:508` 자기인식 정규식 `/너는 누구|정체성|원칙|너의 규칙|self memory|자기인식/i`이 한국어에 편향. 영어 사용자는 self-inquiry 분기 안 탐.
- `chat-engine.ts:1287-1317` MARKET_DATA short-circuit이 stream 모드에서는 작동 안 함(`meta.stream !== true` 조건). 금융 질문을 스트림으로 하면 bypass 경로가 다름.
- `/tmp/yua-backend/src/docs/engine/chat-engine.md`는 자동생성 TODO 템플릿 상태 — 공개 레포 품질에서 감점 요소.
- `legacy-chat-engine-adapter.ts`에 이모지 주석(1️⃣~4️⃣) + `chat-engine.ts`도 동일. CLAUDE.md "이모지 금지" 규칙과 충돌.
