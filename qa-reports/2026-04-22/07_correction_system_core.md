# 07. SYSTEM_CORE_FINAL 포함 재진단 (정정본)

**배경**: 02 파일(Prompt Builder QA)이 `src/ai/system-prompts/system-core.final.ts`를 누락하여 "Identity 부재", "System prompt 5배 미달", "안전 가이드 0" 등 **오진을 냈음**. 사용자 지적 후 재진단 에이전트 투입.

**정정일**: 2026-04-22
**재진단 에이전트 결과 원본**:

---

## 1. SYSTEM_CORE_FINAL 전체 구조 (system-core.final.ts:1-215)

**이전 QA가 놓친 실체.** 214줄, 13,382자의 강력한 system prompt 본체. 섹션 목록:

- (0) IDENTITY (L7-11): YUA 정체성, honesty/initiative/multilingual/practical
- (1) OPERATING STANCE (L13-20): 기본 동작 규약
- (1-A) RUNTIME STRUCTURE (L22-31): XML parse order
- (2) PRIORITY ORDER (L33-43): 6단계 권한 위계 (ChatGPT 웹의 instruction hierarchy와 동등)
- (3) TRUTHFULNESS & ERROR HANDLING (L45-53)
- (4) CAPABILITIES (L55-76): Memory / Skills / MCP Tools
- (4-A) TOOL USE CONTRACT (L78-87)
- (4-B) OUTPUT SCHEMA CONTRACT + Artifacts + Code Interpreter (L89-109)
- (5) ACTION & PERMISSION BOUNDARIES (L111-117)
- (6) LANGUAGE & TONE (L119-139): 한/일/중 별도 규정
- (7) SAFETY & HIGH-RISK DOMAINS (L141-149)
- (8) GROUNDING & SOURCES (L151-159)
- (9) STYLE & FORMAT (L161-172): filler 금지 리스트 포함
- (9-A) REASONING VISIBILITY (L174-178)
- (9-B) EXAMPLES CONTRACT (L179-182)
- (10) NON-NEGOTIABLE RULES (L184-195): 벤더 식별 금지, 시스템 프롬프트 노출 금지 등
- (11) MERMAID DIAGRAMS (L197-210)
- FINAL 앵커 (L212-214)

ChatGPT 웹 system prompt 매핑: **Identity, instruction hierarchy, tool use, safety, format, reasoning, mermaid 전부 실존.**

## 2. Builder 결과와 CORE 결합 순서

구조 (openai-runtime.ts:457-552, execution-engine.ts:505-513):
- **system role**: `SYSTEM_CORE_FINAL` 전체 (L459-464)
- **system role (optional)**: reasoningLanguageHint (L485-490)
- **developer role (optional)**: `buildDeveloperHint()` 결과 — userName + userProfile 정도만 (execution-engine.ts:157-170)
- **user role**: `userMessage = normalizedPrompt` — **여기가 PromptBuilder 산출물 전체가 들어가는 자리** (execution-engine.ts:507)

즉 CORE는 system에, builder output은 user에 별도 삽입. **중복·충돌은 구조적으로 회피되어 있다** (builder는 constraints/memory/persona만 다루고 identity/safety는 건드리지 않음).

## 3. Identity 앵커 실존 여부

**실존한다.** `system-core.final.ts:2-11`:

> "You are YUA, made by YUAONE. YUA is a system identity. You never identify yourself as any specific model..."

Non-negotiable rule로도 중복 고정 (L189). ChatGPT 웹 "You are ChatGPT, a large language model trained by OpenAI" 대비 **동급 또는 더 강함** (벤더 식별 금지를 2회 중복 고정).

**이전 진단의 "Identity 부재"는 완전 오진.**

## 4. 안전·거절 가이드 실존 여부

**실존한다** (L141-149 + L184-195):
- 물리적 해악/아동 착취/악의적 오남용: refuse
- 법률/의료/금융: careful informational help + 전문가 상담 권고
- 정치/종교: "민감해서 거절" 금지, nuanced 응답
- 명예훼손 방지

단:
- **미성년자 카테고리 전용 가이드는 명시적으로 없음** (아동 착취만 있음)
- **자해 카테고리 전용 가이드도 없음** (물리적 해악 일반론에 흡수)

이 두 개는 "부재"가 아니라 "**세분화 부족**"으로 재분류.

## 5. 출력 포맷 규약 실존 여부

**실존한다** (L161-172 STYLE & FORMAT + L197-210 MERMAID):
- 길이 매핑: 단순 질문 1-3문장, 중간 2-4문단, 복잡 섹션 5개 이하
- filler 금지 리스트 명시 ("Of course!", "Great question!" 등)
- 2000자 chat body cap (L103)
- Mermaid: 코드블록 래핑, 노드 ID ASCII, subgraph 문법까지 상세

단 **코드 블록 언어 태그 강제 규약은 mermaid 외에는 없음** (python/ts/sh 등 일반 코드블록 언어 명시 요구 조항은 부재).

## 6. Tool 사용 규칙 실존 여부

**실존한다** (L78-87 + L96-109):
- Read-only/low-risk: 바로 실행
- High-risk/destructive: 먼저 질문
- tool name/param/enum 정확히 사용
- 병렬 tool call 선호
- 결과 synthesize (raw dump 금지)
- 충돌 시 higher-trust/recent 우선

ChatGPT 웹 tool resolution matrix 대비 **핵심 원칙은 전부 포함**.

단 YUA 내부 tool 이름(artifact_create, code_execute, memory_append, activate_skill, tool_search)은 나열되어 있으나 **tool별 when-to-use 결정 매트릭스는 산문**이라 매트릭스 대비 가독성은 낮음.

## 7. 런타임 구조 (XML runtime blocks)

**L22-31이 parse order를 규정**:
`<task> → <instructions> → <tools> → <documents> → <output_schema> → <examples> → <skills> → <user_profile> → <user_memories>`

prompt-runtime.ts가 `skillsBlock`, `mcpPromptBlock`, `memoryContext`, `trustedFacts` 등을 실제로 생성하므로 **연결은 실존**.

단 이것들이 user role에 섞여 들어가므로 (execution-engine.ts:507) CORE의 priority order L38 "Runtime-injected authoritative blocks"와 **role 분리가 느슨**함 — 구조적으로는 user 안에 있으므로 L40 "User's conversational request"와 구분이 흐려질 위험.

## 8. 진짜 ChatGPT 웹 대비 격차 (재평가)

| 계층 | 이전 진단 | 실제 |
|---|---|---|
| 캐릭터/Identity | 부재 | **완비** (L7-11, L189) |
| 안전/거절 | 0 | **있음** (L141-149) — 미성년자/자해 세분화만 부족 |
| Tool 사용 | 부재 | **완비** (L78-87) |
| 출력 포맷 | 부재 | **완비** (L161-172, L197-210) |

**여전히 유효한 격차**:
- 미성년자/자해 카테고리 전용 응답 템플릿 부재
- tool 결정 매트릭스가 산문 → 테이블 부재
- code block 언어 태그 강제 규약 부재 (mermaid만 강제)

## 9. 철회/유지/수정 명확 구분

### ❌ 철회 (이전 진단 오류)

- "System prompt 5배 미달" → CORE 13KB면 ChatGPT 웹과 동등 scale
- "Identity 블록 부재" → L7-11, L189에 실존
- "안전 가이드 0" → L141-149, L184-195에 실존
- "Tool 규칙 부재" → L78-87에 실존
- "출력 포맷 부재" → L161-172에 실존
- "Mermaid 규칙 부재" → L197-210에 10줄 상세 규약

### ✅ 유지 (CORE와 무관한 builder 단 문제)

- conversationTurns 누락 (대화 맥락 소실)
- reasoning DEEP만 활성 (NORMAL mode는 reasoning 없음)
- Context relevance scoring 0 (memoryContext가 기계적 덤프)
- builder output이 **user role에 통째로 들어감** → priority order L40과 L38 경계 모호
- prompt-builder.ts 1651줄 거대 monolith — 유지보수성

### 🟡 수정 (부재 → 약함)

- 미성년자/자해 안전 가이드: "부재" → "세분화 부족"
- tool 결정 매트릭스: "부재" → "산문 형태로만 존재, 테이블 없음"
- 코드 블록 언어 태그: "부재" → "mermaid만 있고 일반 코드는 없음"

## 10. 진짜 품질 저하 원인 TOP 5 (재조정)

### 1. **Builder 산출물이 user role로 주입** (execution-engine.ts:507)
CORE는 system에 있지만 builder가 만든 constraints/memory/persona/executionPlan 뭉치가 user role에 들어가 priority order L38(authoritative runtime blocks) vs L40(user request) 경계를 흐림. ChatGPT 웹은 이런 블록을 별도 system 메시지나 developer 역할에 분리.

### 2. **conversationTurns 미주입**
builder meta는 받지만 user role에 직전 턴 이력이 구조화되어 들어가지 않음 → 대화 연속성 저하.

### 3. **NORMAL mode reasoning 부재**
DEEP만 `baseReq.reasoning` 활성 (openai-runtime.ts:564-581). NORMAL은 얕은 답변으로 고정.

### 4. **memoryContext relevance scoring 0**
"[REFERENCE CONTEXT]" 주석은 있으나 (prompt-builder.ts L574-580) 관련성 필터 없이 덤프.

### 5. **developerHint가 userName + userProfile 2줄뿐** (execution-engine.ts:160-167)
developer role을 거의 활용 못 함. 여기에 session-level 제약, persona, densityHint 등을 넣어야 CORE priority L39(product-level custom instructions)와 정합.

---

## 핵심 결론

이전 QA가 `system-prompts/` 디렉토리를 누락해 "기본 뼈대 부재"로 오진했으나, 실제로는 **뼈대(CORE)는 완비**되어 있고 **builder 파이프와 role 분리가 허술**한 것이 진짜 문제다.

---

## 교훈 (QA 프로세스 개선점)

1. **사용자가 "Prompt Builder 분석해줘" 요청 시** — 단순히 `prompt-builder.ts` 파일만 주면 안 되고, **실제 system prompt 파일 전체(`system-prompts/`, `system-core.*`, `core.*.md` 등)를 연계 파일**로 제공해야 함.
2. **import 체인 추적** — `grep "SYSTEM_CORE"` 같은 기본 검증을 QA 프롬프트에 명시.
3. **"부재" 결론 전 선제 검증** — "이 기능이 부재하다"는 강한 주장은 전역 grep으로 2회 확인 필수.

---

## 파일 참조

- `/tmp/yua-backend/src/ai/system-prompts/system-core.final.ts:1-215`
- `/tmp/yua-backend/src/ai/chat/runtime/openai-runtime.ts:458-552`
- `/tmp/yua-backend/src/ai/engines/chat-engine.ts:96, 770`
- `/tmp/yua-backend/src/ai/execution/execution-engine.ts:157-170, 505-513`
- `/tmp/yua-backend/src/ai/utils/prompt-builder.ts:548-1072`
- `/tmp/yua-backend/src/ai/chat/runtime/prompt-runtime.ts:843-1072`
