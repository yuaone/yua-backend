# 02. Prompt Builder QA 원본 진단

**대상 파일 (5종)**:
- `src/ai/utils/prompt-builder.ts` (1,651줄, 메인)
- `src/ai/utils/prompt-builder-lite.ts` (90줄)
- `src/ai/utils/prompt-builder-deep.ts` (251줄)
- `src/ai/utils/doc-prompt-builder.ts` (109줄)
- `src/connectors/mcp/mcp-prompt-builder.ts` (65줄)

**참조 문서**:
- `src/docs/engine/prompt-builder.md` (203줄, 유일 내용 있음)
- `src/docs/engine/system-core.prompt.md` (빈 stub)
- `src/docs/engine/system-behavior.prompt.md` (빈 stub)

---

## 핵심 요약

`prompt-builder.ts` 전체에 "IDENTITY", 안전/거절 가이드, 출력 포맷 지시가 **전혀 없다**. PromptBuilderLite에만 `[IDENTITY] 너는 YUA다` 한 줄 있다.

---

## 1. System prompt 총 토큰 분량

실측: 외부 주입(memory/skills/file/tool 블록) 제외한 **순수 system guideline 베이스라인은 약 400-900 토큰** 수준이다.

- `prompt-builder.ts:1475-1533` 최종 조립부는 `[SYSTEM GUIDELINES]` 헤더 + 10여 개 Boolean-filtered hint line이 전부.
- Deep 모드(`prompt-builder-deep.ts:227-248`)도 `[THINKING CONTEXT]`·`[DEPTH HINT]`·`[DEEP FLOW CONTRACT]`·`[RESPONSE GUIDANCE]` 4개 블록으로 **700-1200 토큰**.
- **ChatGPT 웹 유출본(5K-8K) 대비 최소 5배 이상 미달**.
- Lite는 `prompt-builder-lite.ts:40-87` 통째로 **100-150 토큰**.

외부 블록(memory/skills/RAG) 합쳐도 ChatGPT가 가진 "캐릭터+안전+tool 규칙+포맷" 4계층이 빠져 있어 토큰 총량은 비슷해도 **밀도가 낮다**.

## 2. 역할·페르소나 정의

- 메인 빌더 `prompt-builder.ts`에는 **YUA라는 1인칭 identity 블록이 존재하지 않는다**.
- `Grep "IDENTITY|YOU ARE"` 결과 0건.
- "YUA"라는 단어는 `prompt-builder.ts:487, 494`의 self-reference 금지 문구에서만 간접 등장.
- 반면 Lite는 `prompt-builder-lite.ts:13-17`에 `[IDENTITY] 너는 YUA다. 외부 AI가 아니다.` 단 2줄.
- 톤 정의(`inferTone`, 198-320행)는 **7개 profile + 3 intensity 동적 계산**으로 과도하게 복잡한 반면, "YUA는 누구인가, 무엇을 지향하는가, 어떤 가치관인가"라는 **캐릭터 DNA**는 어디에도 없다.
- ChatGPT 웹 프롬프트는 `"You are ChatGPT, a large language model trained by OpenAI. Knowledge cutoff: ..."`로 시작하는 강한 정체성 앵커가 있는데, YUA는 그게 부재한다.

## 3. Tool 사용 규칙

- `mcp-prompt-builder.ts:39-63`이 **유일한 tool 사용 meta guide**. 7가지 규칙("match user intent", "no confirmation needed", "handle errors gracefully" 등)은 잘 쓰여 있으나 **MCP 도구가 연결됐을 때만 주입**된다(`prompt-builder.ts:885-889`).
- **내장 도구**(search, file-rag, skills, artifact)에 대한 **언제 쓰고 언제 안 쓰는지의 meta rule이 없다**.
- `prompt-builder.ts:862-883`의 skills 블록 규칙은 "전부 나열하라, 추측하지 마라"에만 집중, 툴 간 우선순위(예: MCP vs 내장 search vs memory)와 실패 시 fallback 순서는 코드 어디에도 없다.
- `trustedFacts`(1512-1519)와 `fileRagBlock`(1021-1025)이 충돌할 때 어느 것을 우선할지도 미정의.

## 4. 출력 포맷 강제

**치명적으로 부재**.

- `Grep markdown|JSON|code block|length|maxWords` 결과, 메인 빌더에는 포맷 지시가 **0건**.
- Doc 전용 빌더만 `doc-prompt-builder.ts:22, 33, 39, 46`에 `"Output clean markdown"` 한 줄씩.
- 길이 제한, 코드 블록 언어 태그 강제, 리스트 vs 프로즈 선택 기준, 수식/테이블 처리 규칙이 전무.
- `prompt-builder.ts:405-423`의 `buildDensityHint`는 "간결하게/자연스럽게/충분히" 같은 **추상적 자연어 힌트**뿐.
- ChatGPT 웹은 "Use markdown only where rendering supports it. Code blocks must specify language. Keep responses under N words unless user asks for more." 같은 **구조적 포맷 규약**을 명시하는데 여기엔 그게 없다.

## 5. 안전·거절 가이드

**가장 큰 구멍**.

- `Grep safety|refuse|minor|suicide|harm|아동|자살|거절` 결과 **0건**.
- 안전 체계는 `prompt-builder.ts:686-696`의 `GuardrailManager.scan()` **외부 필터 단 1개**에 전부 의존.
- 모델 자체가 "어떤 요청을 어떤 톤으로 거절하라"는 가이드를 system prompt에서 받지 않는다.
- 미성년자·폭력·의료·법률·자해·정치적 중립성 가이드 전부 부재.
- ChatGPT 웹이 가진 "If the user requests X, respond with Y-style refusal citing Z" 템플릿이 전혀 없다.
- 결과적으로 모델이 거절을 해도 **뉘앙스·톤이 랜덤**하게 나올 수밖에 없다.

## 6. Context injection 패턴

이 부분은 상대적으로 잘 설계됨.

- `prompt-builder.ts:840-860` memoryBlock
- `862-883` skillsBlock (authoritative 블록 분리)
- `902-923` fileSessionBlock
- `1021-1025` fileRagBlock
- `1237-1244` attachmentBlock with citation format
- `1250-1260` anchorBlock

**계층적으로 분리**돼 있다.

- `prompt-builder.ts:751-762, 1539` prompt cache 키 구성도 `memoryHash(simpleHash)` 활용해 10KB blob을 피한다 — 이건 훌륭함.
- 다만 **Anthropic cache_control 블록(ephemeral/persistent)을 전혀 활용하지 않는다**. 모든 context가 매 턴 재생성되어 cache hit이 CachingEngine 내부 key 매칭에만 의존.
- ChatGPT/Claude API가 지원하는 `cache_control: {"type": "ephemeral"}` marker 미사용으로 **반복 대화에서 토큰 비용 낭비**.

## 7. Lite / Normal / Deep / Doc / MCP 5변형 논리

- **Lite** (`prompt-builder-lite.ts`): greeting/trivial regex 분기(19-29행) + identity 2줄. 용도 명확.
- **Normal** (`prompt-builder.ts`): 1651줄 거대 빌더. Deep-like 힌트(`deepExplanationHint` 1419-1426)가 들어 있어 **Deep과 책임 중복**.
- **Deep** (`prompt-builder-deep.ts`): `DEEP_FLOW_CONTRACT`(120-134)가 Normal의 `NaturalFlowGuard`(429-449)와 **철학적으로 충돌**. Normal은 "HIGH momentum에서만 구조 허용", Deep은 "쟁점 2-3개 순차 전개" 강제. 같은 질문이 Normal/Deep 경로로 흘러갈 때 출력 품질이 불안정해질 수 있음. Deep에는 `YUA_IDENTITY_BLOCK`이 없어 **Lite보다 정체성이 약하다**.
- **Doc** (`doc-prompt-builder.ts`): 5 mode(generate/rewrite/summarize/translate/chat) 분리 명확. chat 모드(48-55행)만 인용 citation 규칙이 있음.
- **MCP** (`mcp-prompt-builder.ts`): 블록 생성만 담당, 올바른 설계.

**핵심 중복/충돌**:
- Normal의 `deepExplanationHint`와 Deep의 `depthHint=FORMAL`이 경로 분기 없이 공존.
- `system-core.prompt.md`·`system-behavior.prompt.md`는 자동생성 stub이라 **실제 SSOT가 없고**(file:1-55 공란) `prompt-builder.md` 헌법만 살아 있다.
- 헌법 준수 검증 장치도 없음.

## 8. 품질 저하 TOP 5 결정 요인

### 1. 정체성 앵커 부재
`prompt-builder.ts` 전체에 `[IDENTITY]` 블록이 없다. Lite `prompt-builder-lite.ts:13-17`을 모든 빌더 공통 preamble로 승격하고, "YUA는 누구인가"를 50-150 토큰으로 명시해야 한다.

### 2. 출력 포맷 규약 전무
`prompt-builder.ts:1475-1533` 최종 조립부에 markdown/code block/length 규칙이 0건. `[OUTPUT FORMAT]` 블록을 신설해 "코드 블록은 언어 태그 필수, 표는 3열 이상일 때만, 리스트는 병렬 항목 3개 이상일 때만" 같은 **결정 규칙**을 명문화해야 한다.

### 3. 안전·거절 가이드 0건
`GuardrailManager.scan()`(686-696) 외부 필터에 전부 위임. 모델이 거절할 때의 톤·형식을 알려주는 `[REFUSAL STYLE]` 블록이 필요. 미성년자·의료·법률·자해 카테고리별 응답 스캐폴드.

### 4. Tool 우선순위·fallback 미정의
MCP(`mcp-prompt-builder.ts:39-63`)는 잘 돼 있으나 내장 도구(search/RAG/skills/memory/trustedFacts)가 **충돌할 때 어느 것을 믿을지**가 `prompt-builder.ts:1358-1367` `forceUseTrustedFacts`에 희미하게 있을 뿐. Tool resolution matrix를 system prompt에 박아야 한다.

### 5. 힌트 과잉·명령 과소
`systemGuidelines`(`prompt-builder.ts:1428-1472`)가 22개 optional hint의 `.filter(Boolean).join("\n")`으로 구성돼 **대부분의 경로에서 빈 문자열**로 접히거나 **서로 모순되는 톤 라인이 섞인다**(`buildToneHint` CASUAL과 `assertiveExpressionHint` CONFIDENT 동시 활성 가능). ChatGPT 웹처럼 "항상 적용되는 core 규약 60%" + "상황별 hint 40%" 비율로 재구성하고, 상충 힌트는 빌드 시점에 dedupe 해야 한다.

## 추가 발견

- `system-core.prompt.md`, `system-behavior.prompt.md`(각 55줄) 둘 다 **자동생성된 빈 템플릿**. SSOT 문서로 오해될 수 있어 위험. 둘 다 `Purpose:`, `Input Schema:` 내용이 공란.
- `prompt-builder.ts:1651`줄이나 되는 단일 파일은 QA 관점에서 **테스트 커버리지 확보 불가능**. 블록 단위 pure function 분리 필요.
- cache key(`prompt-builder.ts:751-762`)에 `depthHint`, `leadHint`, `implementationMode`, `designMode`가 빠져 있어 **동일 message에 다른 mode면 잘못된 cache hit 가능**(765행 `if (cached && !designMode)` 방어는 부분적).
