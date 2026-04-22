# 01. OpenAI Runtime QA 원본 진단

**파일**: `src/ai/chat/runtime/openai-runtime.ts`
**진단일**: 2026-04-22
**진단 범위**: 모델 호출 파라미터 · Streaming · Tool calling · 에러 핸들링 · 메시지 조립 · 토큰 회계 · ChatGPT 웹 대비 부재 항목

---

## 1. 모델 호출 파라미터

- **L399-400**: 클라이언트가 `runOpenAIRuntime` 내부에서 `new OpenAI()` 직생성. `openai-client.ts`의 MOCK/wrap 레이어(L24-36) 사용 안 함 — 재시도/로깅/장애 페일세이프 우회.
- **L427-437**: `temperature` 0.4/0.5/0.6, `top_p` 0.95 강제 주입. 그런데 L591-592 주석에 "Responses API(GPT-5.x)는 sampling params를 ignore한다"고 본인이 적어놓고도 L554-558 `baseReq`에는 아예 안 실음 — 코드와 의도 불일치. 반면 `seed`(L594)는 실림.
- **L564-581**: `reasoning`이 **`mode === "DEEP"`에서만** 활성화. NORMAL/SEARCH/BENCH/RESEARCH는 GPT-5.4인데도 reasoning 미적용. ChatGPT 웹은 질문 복잡도 따라 자동 승격하지만 여기선 그냥 꺼져있음 → **품질 저하 최대 원인**.
- **L596-601**: `verbosity`가 planTier 기반으로 free=low 강제(L286). free 계정은 한두 문단으로 잘려 나옴.
- `response_format`(json_schema)은 L377, L597-600에서 caller가 textFormat 주입할 때만 세팅. 기본은 text.

## 2. Streaming 처리

- **L626-627**: `client.responses.create(..., {stream:true})` 정상. L621 90초 wall-clock timeout은 DEEP/RESEARCH(reasoning high) 질의에서 **중단 위험** — o1/o3급은 90초 넘는 케이스 다수.
- **L795-811** `output_text.delta`: delta 그대로 흘림. L800-806의 `{"steps"/"reasoning"}` JSON 문자열 차단 필터는 휴리스틱 — 정상 답변에 해당 단어가 코드블록으로 포함되면 오탐.
- **L652-686** reasoning idle-flush 로직(REASONING_IDLE_MS=1200, MIN_LEN=320)은 복잡하지만 sequence_number 기반 정렬 없이 Date.now()로 판단 → **스트림 이벤트가 몰려오면 reasoning이 한꺼번에 묶여 UX 저하**.
- **에러 복구**: try/finally(L648, L1128-1129)에 `finally {}`가 비어 있음 → **stream 중 throw 시 사용자한테 의미있는 메시지 없이 끊김**.

## 3. Tool calling 구현

- **L603-607**: `tools`는 caller가 주면 pass-through. **기본 `tools` 없음** — web_search, code_interpreter, file_search 내장 tool이 runtime 레벨에서 자동 주입되지 않음. ChatGPT 웹은 항상 라우팅되는 기능.
- **L907-923** function_call/custom_tool_call 수신은 구현되어 있으나, **tool 결과 재주입(continuation) 루프가 이 파일에 없음** — L1121 "allow outer loop to decide continuation" 주석으로 ExecutionEngine에 떠넘김. 이 파일만 보면 tool 결과를 받아 다음 턴 호출하는 코드 부재.
- `parallel_tool_calls` 플래그 설정 없음. Responses API 기본값(true) 의존.
- **무한루프 방지**(tool call depth limit) 없음.

## 4. 에러 핸들링·재시도

- **재시도 0회**. 429/500/timeout 모두 그대로 상위로 throw. OpenAI SDK의 기본 `maxRetries`(2회) 의존하지만 `new OpenAI({apiKey})`에서 명시 안 함.
- exponential backoff 없음.
- context length 초과(`context_length_exceeded`) 감지/축약 로직 없음 — 긴 대화에서 바로 에러.
- L619-624 AbortSignal 조합은 OK.

## 5. 메시지 조립

- **L459-465** `system` → **L467-490** language hint(system) → **L494-500** `developer` → **L502-504** `inputOverride` → **L507-552** user 순서. 양호.
- 주의: L467-490 `reasoningLanguageHint`를 system role로 push — 두 system 메시지가 연속 들어감. Responses API 허용하지만 일부 모델에서 가중치 편향 가능.
- `tool_call_id` 연결: `ResponseToolResultInputItem`(L140-144)은 정의만 되고 `ResponseInputItem` union(L150-152)에 **빠져있음** — `function_call_output`만 포함. 이전 assistant tool_calls 재전달 구조가 이 파일 스코프에서 불완전.
- `conversation` vs `previous_response_id`(L585-589): conversation 우선. 대화 연속성은 OK.

## 6. 토큰 회계

- **L1100-1104**: `response.completed`의 usage만 추출. cost 계산 없음.
- **L1143-1156**: non-stream 응답에서 **답변을 제목 정규화용으로 잘라버림**(24자 slice, 특수문자 전부 제거). 이건 "auto-title 전용" 경로인데 같은 runtime 함수가 일반 호출에도 쓰이면 본문이 날아감 — **분기 주석(L1145)은 있지만 caller가 구분 안 하면 치명적**.
- token count 사전 방어(tiktoken 등) 없음.

## 7. ChatGPT 웹에 있고 여기 없는 것

- **5000+ 토큰 시스템 프롬프트**: `SYSTEM_CORE_FINAL` 하나만 주입(L463). 내용 크기 이 파일에서 미확인이지만, 웹 수준 가이드 부재 가능성 큼.
- **자동 tool 라우팅**: web_search/code_interpreter를 런타임 기본 tools로 안 넣음.
- **reasoning 동적 조정**: DEEP 모드 외 전부 reasoning off(L564).
- **메모리/사용자 프로필 주입**: 없음.
- **후처리**(citation 포맷팅, markdown 정돈, 안전필터 2단계): 없음.
- **다양한 verbosity 대응**: free=low로 너무 짧게 강제.

## 8. 개선 제안 TOP 5

### 1. L564-581 reasoning 기본 활성화
`mode === "DEEP"` 조건 제거하고 NORMAL에도 `effort:"low"`, SEARCH/BENCH에 `"medium"`을 기본 주입. 체감 품질 최대 상승.

```typescript
reasoning: mode === "DEEP" ? { effort: "high" } :
           mode === "RESEARCH" ? { effort: "medium" } :
           mode === "SEARCH" ? { effort: "medium" } :
           mode === "BENCH" ? { effort: "low" } :
           { effort: "low" }  // NORMAL 도 low 켬
```

### 2. L603-607 tools 기본 주입
caller가 안 줘도 `[{type:"web_search"}, {type:"code_interpreter", container:{type:"auto"}}]`를 default로 넣고 `tool_choice:"auto"`. ChatGPT 웹 parity.

```typescript
tools: tools ?? [
  { type: "web_search" },
  { type: "code_interpreter", container: { type: "auto" } },
],
tool_choice: tool_choice ?? "auto",
```

### 3. L621 타임아웃 조정 + 재시도
DEEP/RESEARCH는 300초, 그 외 120초로 mode별 분기. `new OpenAI({apiKey, maxRetries:3, timeout:...})` 명시(L399).

```typescript
const client = new OpenAI({
  apiKey,
  maxRetries: 3,
  timeout: mode === "DEEP" || mode === "RESEARCH" ? 300_000 : 120_000
});
```

### 4. L286-293 verbosity 정책 완화
free=low는 과도. free=medium으로 올리거나 질문 길이 기반 동적 판정. 짧은 답변이 품질 인상 낮춤의 주범.

```typescript
const verbosity =
  mode === "DEEP" ? "high" :
  planTier === "free" ? "medium" :  // 원래 "low"
  "medium";
```

### 5. L1143-1161 auto-title 로직 분리
이 경로를 별도 함수 `runOpenAITitleRuntime`으로 빼고, 일반 non-stream은 `res.output_text` 원문 반환. 현재 구조는 일반 호출자가 실수로 제목화된 텍스트 받을 위험.

## 보너스 발견

- **L400** fallback 모델이 `"gpt-4.1-mini"` — MODEL_BY_MODE에 없는 mode가 오면 구형 모델로 폴백. 현재 타입상 닿지 않지만 리팩토링 시 함정.
- `openai-client.ts`의 wrapper가 실제로 **한 번도 안 쓰임**(L399에서 OpenAI 직생성). MOCK 페일세이프 무효화. docs 언급한 `openai-client.md`가 runtime과 연결 안 된 상태.
