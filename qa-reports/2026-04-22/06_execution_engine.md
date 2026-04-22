# 06. Execution Engine QA 원본 진단

**주 파일**: `src/ai/execution/execution-engine.ts` (4,187줄)

**연계**:
- `src/ai/execution/continuation-prompt.ts`
- `src/ai/asset/execution/document/document-execution.engine.ts`
- `src/ai/tools/openai-tool-registry.ts`
- `src/ai/engines/chat-engine.ts` (상위 호출자)
- `src/ai/code/sandbox-exec.ts`

---

## 1. 실행 루프 구조

`execution-engine.ts:1557-1583`의 단일 `while` 루프가 segment 단위로 `runOpenAIRuntime` 호출 → stream 파싱 → tool 실행 → `continuationInput` 재주입을 반복.

**루프 종료 조건이 5중 가드**:
- `MAX_SEGMENTS`
- `HARD_SEGMENT_CAP`
- `MAX_TOTAL_EXECUTIONS`
- `MAX_TOOL_CONTINUATIONS=5`
- `segmentIndex<6`

DEEP은 segment 3, NORMAL 2, FAST 1로 타이트.

**무한루프 방지는 다층이지만**, OpenAI가 동일 tool을 5회 연속 요구하면 `MAX_TOOL_CONTINUATIONS`에서 막혀 답변이 잘려도 사용자에게 고지 없음(3295줄 `toolContinuationCount++` 후 cap 도달해도 graceful degradation 부재).

## 2. Tool 등록·디스커버리

**하이브리드 하드코딩**.

- 네이티브 tool(`web_search`, `code_interpreter`, `analyze_image/csv`, `quant_analyze`, `artifact_create/update`, `memory_append`, `activate_skill`, `code_execute`)은 `execution-engine.ts:710-1013`에서 조건부 inline push.
- `openai-tool-registry.ts`는 8개 SSOT registry가 있지만 엔진은 이를 일부만 사용하고 **schema를 재선언**(예: `code_execute`는 레지스트리에 없음, `quant_analyze`도 inline only).
- MCP/Google은 `_toolAssemblyCache` (userId 60s TTL, 1022줄)로 동적 로드.

**두 개의 진실 원천**이 공존 → schema drift 위험.

레지스트리의 `web_search` 핸들러는 `OPENAI_NATIVE_WEB_SEARCH_UNSUPPORTED`를 반환하는 스텁(76줄)이고 실제 실행은 OpenAI 서버가 수행, 혼란 유발.

## 3. 병렬 tool call 처리

**실질적 병렬 처리 없음**.

- `pendingToolOutputs = new Map<callId, output>`(1438줄)에 같은 response의 여러 tool_call을 누적하지만,
- 각 `tool_call_arguments_done` 핸들러(2323~3170줄)는 `await`로 **직렬 실행**.
- `Promise.all` 검색 결과 tool 관련 병렬 없음(유일하게 Google+MCP **등록** 단계만 병렬).

ChatGPT 웹처럼 web_search + code_interpreter 동시 실행은 불가능. 모델이 3개 tool call을 한 응답에 내놓으면 순차 처리.

## 4. Continuation prompt

`continuation-prompt.ts`가 `previousAnswerTail`(마지막 1200자, 3579줄)만 앵커로 삼아 "이어 말하기" 강제.

**두 갈래 경로가 혼재**:
- (a) function_call_output 주입 — `buildToolResultInput`(1492줄), Responses API 정식 포맷
- (b) 텍스트 prompt 재주입 — `buildContinuationMessageInput` + `[TOOL_RESULT]` 블록(3428-3467줄)

DEEP stream path에서만 (b)를 쓰고 일반 path는 (a).

`VERIFIER_FAILED` 시(3522줄) `previousAnswerTail=""`로 넘겨 앵커 자체를 제거 — 이때 버퍼 리셋 누락으로 앞부분 내용이 사라질 수 있음.

## 5. 에러·timeout·sandbox

**Timeout 스펙이 tool마다 제각각**:
- `code_execute` 35s(2794줄)
- MCP 15s(3114줄)
- Google API 15s(3067줄)
- Python `/capabilities` 3s(917줄)

**실패 시 LLM에게 전달하는 포맷도 불일치**:
- 어떤 건 `{ok:false,error:...}`, 어떤 건 `"Error: msg"` 문자열
- `execution-engine.ts:3154-3156`처럼 문자열로 주입하면 모델이 에러를 content로 오해할 소지

Abort는 `executionAbort: AbortController`(1143줄) 단일 SSOT로 일원화되어 있는 게 강점.

`code_execute`는 외부 파이썬 런타임(`PYTHON_RUNTIME_URL`, 기본 `127.0.0.1:5100`)에 위임 — 엔진 자체 샌드박싱 없음.

## 6. 결과 포맷 변환

- `compressToolResult`(151줄)로 1000자 클램프
- `MAX_TOOL_RESULT_CHARS = 50000`(3432줄) 하드캡
- `code_execute`는 10000자(2913줄), MCP 10000자(3121줄), Google은 무제한(3069줄)
- JSON smart-trim이 `parsed.output.files[i].trend.points` 등 **특정 필드만** 알아서 자름(3439-3450줄) — 스키마 가정된 하드코딩이라 다른 tool에선 그냥 `slice(0, 50000)`로 블라인드 truncate 되어 JSON 파싱 깨질 가능성.
- `tool-result-normalizer.ts`가 있지만 execution-engine에서 import조차 안 함.

## 7. 상태 관리

**휘발성 위주**.

- `segmentIndex`, `nativeToolOutputs`, `pendingToolOutputs`는 메모리 Map.

**영속 저장**:
- (a) `conversation_threads.openai_conversation_id`(1330줄) — `previousResponseId`는 DB 안 싣음(주석: "stale causes 400")
- (b) `tool_call_logs` INSERT(3127줄) 성공 케이스만
- (c) assistant pending row(1545줄)

**크래시 복구 불가능**: segment 2에서 프로세스 죽으면 재개 경로 없음, 사용자는 빈 pending 메시지만 봄(복구 시 `deletePending`은 abort 경로만, 4141줄).

## 8. Long-running tool

실질 캡 15-35s.

`idleTimer`는 SEARCH/FAST 1.2s, NORMAL/DEEP 3s(1620줄)로 **입력 aggregation용**이지 tool 실행 타임아웃 아님.

파일 처리/웹스크래핑같이 1-2분 걸리는 워크플로는 구조적으로 불가능(MCP 15s 하드캡).

진행률 피드백은 `publishActivity` PATCH로 UI에 emit하지만 tool 내부 중간 progress 이벤트 프로토콜 없음.

## 9. Security

- (a) OpenAI-hosted `code_interpreter`는 `container:{type:"auto"}`(725줄)로 OpenAI 샌드박스 사용.
- (b) 자체 `code_execute`는 외부 Python 런타임에 위임, 엔진 레벨 격리 없음.
- (c) Node용 `SandboxExec`(sandbox-exec.ts)는 **substring 블랙리스트**("require(", "fs." 등)로 매우 취약 — `require\u0028` 같은 우회 자명. `env:{}`만 비우고 `spawn("node", ["-e", code])`라 fs/network 접근 차단 무효.
- (d) `[INSTRUCTION]/[SYSTEM]` prompt injection 필터(3422줄)는 문자열 대체 수준, `⟦YUA⟧` directive 우회는 `[YUA_ESCAPED]` 치환으로 대응하나 Unicode homoglyph 방어 없음.

## 10. ChatGPT 웹 vs 이 엔진

- 병렬 tool 동시 실행 **없음** → ChatGPT는 web_search + code_interpreter 동시 호출 가능.
- Tool 결과 중간 진행률(stream progress) **없음** → ChatGPT는 "Searching...", "Running code..." 단계 세분화.
- Long-running 작업(>1min) **불가능** → ChatGPT Agents는 10분+ 감당.
- Crash/resume **없음** → ChatGPT는 response_id로 재연결.
- Canvas 유사 surface는 `artifact_create/update`로 흉내내지만 **스트리밍 편집**(diff patch) 없이 replace/append만.

## 11. 품질 저하 원인 TOP 5

### 1. Tool 스키마 이중 선언
`execution-engine.ts:866-1013`의 inline push vs `openai-tool-registry.ts`.
**개선**: 모든 tool을 registry SSOT로 이동, `buildOpenAIToolSchemas()` 한 곳에서만 emit. `code_execute`, `quant_analyze`도 레지스트리로.

### 2. Segment cap이 너무 타이트
`execution-engine.ts:626-629` DEEP=3, NORMAL=2. ChatGPT agentic은 5-10 easily. Tool 한 번 실패하면 segment 소진되어 복구 불가.
**개선**: DEEP=6, NORMAL=4로 올리고 token budget 기반 동적 조정.

### 3. Tool 결과 truncation이 스키마 가정 하드코딩
`execution-engine.ts:3439-3450`의 `parsed.output.files[i].trend` 같은 특정 경로.
**개선**: generic 재귀 depth/size 기반 trim + tool별 serializer adapter로 분리.

### 4. SandboxExec 블랙리스트 우회 자명
`sandbox-exec.ts:39`. `require\u0028`/`fs\u002e` 등으로 바로 우회.
**개선**: vm2/isolated-vm/Deno subprocess + seccomp 또는 `code_execute`(외부 파이썬 런타임) 쪽으로 모든 실행 단일화.

### 5. 병렬 tool 실행 부재
`execution-engine.ts:2323-3170` `tool_call_arguments_done` 직렬 처리.
**개선**: 같은 response에서 모인 pending tool calls를 `Promise.allSettled`로 실행하고 완료 순이 아닌 callId 순으로 `function_call_output` 배치 주입(Responses API 허용). Parallel-safe tool(search, fetch, code)과 state-mutating tool(memory_append, artifact_update) 구분해 dependency-free만 병렬.

## 추가 관찰

- (a) `execution-engine.ts`가 4187줄 — 단일 파일 응집도가 너무 높음, tool dispatcher를 provider별 파일로 split 권장.
- (b) `runVerifierLoop` import만 있고 호출 안 됨(grep 결과 `verifierBudget`은 수동 관리), **verifier 시스템이 half-wired 상태**.
- (c) `tool-result-normalizer.ts`, `tool-runner.ts` 같은 헬퍼들이 execution-engine에서 bypass되어 **죽은 코드화**.

## 관련 경로

- `/tmp/yua-backend/src/ai/execution/execution-engine.ts:626` (segment cap)
- `/tmp/yua-backend/src/ai/execution/execution-engine.ts:1438` (pendingToolOutputs)
- `/tmp/yua-backend/src/ai/execution/execution-engine.ts:3432` (MAX_TOOL_RESULT_CHARS)
- `/tmp/yua-backend/src/ai/execution/continuation-decision.ts:23`
- `/tmp/yua-backend/src/ai/tools/openai-tool-registry.ts:50`
- `/tmp/yua-backend/src/ai/code/sandbox-exec.ts:39`
