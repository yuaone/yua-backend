# 00. 통합 마스터 진단 + 수정 로드맵 (정정판 포함)

**진단일**: 2026-04-22
**방식**: 6개 병렬 QA 에이전트 + 1개 재진단 에이전트 (SYSTEM_CORE_FINAL 누락 교정)
**대상 레포**: yuaone/yua-backend
**사용자 문제 인식**: ChatGPT 웹 UI vs 자체 API wrapper 품질 격차 체감

---

## ⚠️ QA 오진 교정 안내

초기 Prompt Builder QA 에이전트가 `src/ai/system-prompts/system-core.final.ts` 파일을 **누락**하여 "System prompt 5배 미달", "Identity 부재", "안전 가이드 0" 등의 오진을 냈다. 사용자 지적 후 재진단으로 **정정됨**. 상세는 [07_correction_system_core.md](./07_correction_system_core.md) 참조.

**철회된 주장**:
- ❌ "System prompt 5배 미달 (400~900 토큰)" → **실제 13KB, 3,300~4,400 tok**
- ❌ "Identity 블록 부재" → **L7-11, L189 실존**
- ❌ "안전 가이드 0건" → **L141-149, L184-195 실존**
- ❌ "Tool 규칙 부재" → **L78-87 실존**
- ❌ "출력 포맷 규약 0건" → **L161-172 실존 (단 일반 code block 언어 태그만 부재)**

---

## 🎯 진짜 품질 저하 원인 TOP 10 (정정판)

| # | 결함 | 영역 | 심각도 | 수정 난이도 |
|---|---|---|---|---|
| **1** | **`conversationTurns` 6군데 forward 누락** | Prompt Runtime | ★★★★★★ | 30분 (한 줄 × 6) |
| **2** | **reasoning DEEP 전용 (NORMAL 얕음)** | OpenAI Runtime | ★★★★★ | 5분 |
| **3** | **기본 tools 자동 주입 없음** | OpenAI Runtime | ★★★★★ | 10분 |
| **4** | **Context relevance ranking 0** (scope weight만) | Context Runtime | ★★★★★ | 1일 (임베딩 통합) |
| **5** | **messages 단일-턴 구조** `[system, user]`만 | Prompt Runtime | ★★★★★ | 4시간 |
| **6** | **stream 모드 tool pre-pass 스킵** | Chat Engine | ★★★★★ | 30분 |
| **7** | **병렬 tool 실행 없음** (직렬 await) | Execution Engine | ★★★★★ | 4시간 |
| **8** | **Builder 산출물 user role로 주입** (priority 경계 흐림) | Chat Engine | ★★★★ | 6시간 |
| **9** | **Silent catch-all** (skills/memory 조용히 증발) | Prompt Runtime | ★★★★ | 1시간 |
| **10** | **Summarization DEEP 전용** (20턴 후 FIFO drop) | Context Runtime | ★★★★ | 1일 |

---

## 📋 영역별 주요 결함 요약

### 1. OpenAI Runtime (상세: [01_openai_runtime.md](./01_openai_runtime.md))
- reasoning DEEP 전용 → NORMAL/SEARCH/BENCH/RESEARCH는 얕은 답변
- 기본 tools 자동 주입 없음 → caller 주지 않으면 맨몸 모델
- free verbosity=low 강제 → 무료 사용자 1-2문단 답변
- `new OpenAI()` 직생성으로 `openai-client.ts` wrapper bypass → 재시도 0회
- 90s timeout이 DEEP reasoning 질의 중단 위험
- auto-title logic이 본문도 24자 slice로 자를 위험

### 2. Prompt Builder (상세: [02_prompt_builder.md](./02_prompt_builder.md) + [정정 07](./07_correction_system_core.md))
**정정됨**: CORE 파일에 대부분 규약 실존.

**여전히 유효한 비판**:
- 1,651줄 monolith, 테스트 커버리지 불가
- 힌트 과잉/상충 (22개 optional hint의 .filter(Boolean).join) dedupe 없음
- cache key 필드 누락 (depthHint, leadHint, implementationMode)
- Anthropic cache_control 미활용 → 토큰 비용 낭비
- Normal/Deep path `NaturalFlowGuard` vs `DEEP_FLOW_CONTRACT` 철학적 충돌
- `system-core.prompt.md` / `system-behavior.prompt.md` docs stub이 빈 파일 → 혼선

### 3. Prompt Runtime (상세: [03_prompt_runtime.md](./03_prompt_runtime.md))
**단독 최대 치명상**: `conversationTurns` 6군데 전수 forward 누락.
- L843, L868, L886, L908, L937, L1019 전부 `conversationTurns` 미전달
- PromptBuilder L778-805에 `[RECENT CONVERSATION]` 블록 로직 있으나 **항상 undefined**
- → **매 턴 "새 세션처럼" 동작**

그 외:
- Silent catch-all (L544/546/550/553): skills/memory-md/connectors 조용히 증발
- meta.constraints L826 post-mutation 누락 (L481 effectiveConstraints 뒤에 mutate)
- 세션 수명주기 훅 없음 (stateless)
- Cache key miss 구조로 매 턴 전체 재계산

### 4. Context Runtime (상세: [04_context_runtime.md](./04_context_runtime.md))
- Relevance ranking 0 (scope weight 정적 상수만, 임베딩·BM25 전무)
- 벡터 DB·RAG 파이프라인 부재
- `MAX_CONTEXT_CHARS = 12000` 하드코딩, 토큰 아닌 char 기반 truncation
- `MAX_CONVERSATION_CHUNKS=11`, `MAX_MEMORY_CHUNKS=8` 정의만 있고 미적용
- Summarization DEEP 전용, NORMAL/FAST/SEARCH는 20턴 후 FIFO drop
- `isGeneratedExplanation` 정규식 6개 키워드로 carryLevel 강등 (false positive 심함)
- Race condition 방어 없음 (last-writer-wins)

### 5. Chat Engine (상세: [05_chat_engine.md](./05_chat_engine.md))
- 스트리밍 시 tool pre-pass 스킵 (L763)
- 전역 catch 후 re-throw (부분 복구 없음)
- 모델 정적 테이블, `adaptive-router.ts` 미연결 (죽은 코드)
- SSOT violation hard-fail (L534-538)
- PromptRuntime 40+ 필드 meta 패키징, `(meta as any).uiLocale` drift
- 3중 tool layer (pre-pass + main plan + execution) 따로 놀고 중복/충돌 방지 없음
- `chat-engine-guide-path.ts` 6줄 shim (미구현)
- `legacy-chat-engine-adapter` 이름과 달리 유일한 현역 → 네이밍 혼란

### 6. Execution Engine (상세: [06_execution_engine.md](./06_execution_engine.md))
- Tool 스키마 이중 선언 (registry + inline push) → drift 위험
- 병렬 tool 실행 없음 (`await` 직렬)
- Segment cap 타이트 (DEEP=3, NORMAL=2) → 멀티스텝 제한
- `SandboxExec` 블랙리스트 자명 우회 (`require\u0028`)
- Tool 결과 truncation 스키마 가정 하드코딩
- `runVerifierLoop` import만 있고 호출 안 됨 (half-wired)
- `tool-result-normalizer.ts`, `tool-runner.ts` bypass (죽은 코드)
- 4,187줄 단일 파일 → 유지보수 불가
- Crash/resume 불가 (segment 중간 프로세스 죽으면 빈 pending)

---

## 🚀 수정 로드맵

### P0 — 오늘~내일 (체감 60~70% 해소, 약 1시간 30분)

| # | 작업 | 파일:라인 | 시간 |
|---|---|---|---|
| 1 | **conversationTurns forward 6군데** | `prompt-runtime.ts:843,868,886,908,937,1019` | 30분 |
| 2 | **reasoning 기본 활성화** (모든 모드 최소 low) | `openai-runtime.ts:564-581` | 5분 |
| 3 | **기본 tools 자동 주입** (web_search + code_interpreter) | `openai-runtime.ts:603-607` | 10분 |
| 4 | **free verbosity medium 승격** | `openai-runtime.ts:286-293` | 2분 |
| 5 | **stream 모드 tool pre-pass 실행** | `chat-engine.ts:763` | 30분 |
| 6 | **SSOT violation fallback** (hard-fail → degrade) | `chat-engine.ts:534-538` | 15분 |

**P0 수정 코드 예시**:

```typescript
// ① prompt-runtime.ts 6군데 각각에 한 줄씩 추가
await PromptBuilder.buildChatPrompt({
  ...기존 meta,
  conversationTurns: meta.conversationTurns,  // ← 이 한 줄 추가
});

// ② openai-runtime.ts:564-581
reasoning: mode === "DEEP" ? { effort: "high" } :
           mode === "RESEARCH" ? { effort: "medium" } :
           mode === "SEARCH" ? { effort: "medium" } :
           mode === "BENCH" ? { effort: "low" } :
           { effort: "low" }  // NORMAL도 low 켬

// ③ openai-runtime.ts:603-607
tools: tools ?? [
  { type: "web_search" },
  { type: "code_interpreter", container: { type: "auto" } },
],
tool_choice: tool_choice ?? "auto",

// ④ openai-runtime.ts:286-293
const verbosity =
  mode === "DEEP" ? "high" :
  planTier === "free" ? "medium" :  // 원래 "low"
  "medium";

// ⑤ chat-engine.ts:763
// 기존: const skipStreamingToolPrepass = meta.stream === true;
const skipStreamingToolPrepass = false;  // 또는 cache 구조로 개선

// ⑥ chat-engine.ts:534-538
if (!meta.reasoning || !meta.mode) {
  console.warn("[SSOT_VIOLATION] meta incomplete, using fallback");
  meta.reasoning = meta.reasoning ?? {
    intent: "ask", depth: "normal", confidence: 0.5
  };
  meta.mode = meta.mode ?? "NORMAL";
  // throw 제거
}
```

### P1 — 이번 주 (체감 +30%)

| # | 작업 | 영역 |
|---|---|---|
| 7 | messages 배열에 히스토리 풀어 넣기 (assistant/user role 분리) | Prompt/OpenAI Runtime |
| 8 | Silent catch → warn + telemetry counter | Prompt Runtime |
| 9 | Tool 스키마 SSOT 통합 (registry로 일원화) | Execution Engine |
| 10 | constraint post-mutation 순서 수정 (L826을 L481 앞으로) | Prompt Runtime |
| 11 | adaptive-router 연결 (resolveRuntimeModelId와 bridging) | Chat Engine |
| 12 | 전역 catch → 단계별 graceful degrade | Chat Engine |
| 13 | Builder 산출물을 developer role로 이동 | Chat Engine / Execution |
| 14 | 미성년자/자해 안전 가이드 세분화 추가 | SYSTEM_CORE_FINAL |
| 15 | 일반 code block 언어 태그 강제 규약 추가 | SYSTEM_CORE_FINAL |
| 16 | tool 결정 매트릭스 테이블화 | SYSTEM_CORE_FINAL |

### P2 — 다음 주 (품질 안정화)

| # | 작업 | 영역 |
|---|---|---|
| 17 | 병렬 tool 실행 (`Promise.allSettled`) | Execution Engine |
| 18 | Context relevance ranking (임베딩 cosine + BM25) | Context Runtime |
| 19 | Summarization 모든 모드로 확장 | Context Runtime |
| 20 | Segment cap 완화 (DEEP=6, NORMAL=4) | Execution Engine |
| 21 | Normal vs Deep 경로 통일 (flow contract 충돌 해소) | Prompt Builder |
| 22 | Sandbox 교체 (isolated-vm) | Execution Engine |
| 23 | 모델 adaptive 선택 (질문 복잡도 기반) | Chat Engine |
| 24 | `chat-engine.md` docs 작성 | 문서 |
| 25 | `system-core.prompt.md`/`system-behavior.prompt.md` stub 제거 or 실제 작성 | 문서 |
| 26 | prompt-builder.ts monolith 블록 단위 분리 | Prompt Builder |

### P3 — 장기 (ChatGPT 웹급)

| # | 작업 |
|---|---|
| 27 | 벡터 DB · RAG 파이프라인 (cross-session vector recall) |
| 28 | Cross-session memory (임베딩 기반) |
| 29 | Canvas 스트리밍 편집 (diff patch) |
| 30 | Crash/resume 복구 (response_id 기반 재연결) |
| 31 | OpenTelemetry 구조화 트레이싱 |
| 32 | Adaptive context window (모델·요청 타입별 동적 예산) |
| 33 | Forgetting mechanism (사용자 요청 시 특정 기억 삭제) |
| 34 | Long-running tool (1-10분) 지원 + progress 이벤트 프로토콜 |

---

## 📊 격차 기여도 다이어그램 (추정)

```
ChatGPT 웹 품질: 100
     │
     ├─ ★★★★★★ conversationTurns 누락         (-25)
     ├─ ★★★★★ reasoning DEEP 전용              (-15)
     ├─ ★★★★★ 기본 tools 자동 주입 없음         (-10)
     ├─ ★★★★★ Context relevance 0             (-10)
     ├─ ★★★★★ stream 모드 tool pre-pass 스킵   (-8)
     ├─ ★★★★★ messages 단일-턴 구조            (-7)
     ├─ ★★★★★ 병렬 tool 실행 없음              (-5)
     ├─ ★★★★ Builder user role 주입            (-5)
     ├─ ★★★★ Silent catch                      (-5)
     ├─ ★★★★ Summarization DEEP 전용           (-4)
     └─ 기타                                    (-6)
     ─────────────────────────────────────────
현재 YUA 품질: 100 - 100 = 0 (과장, 실제는 30~40 정도)

P0 6개 수정 후: 예상 70~80
P1 10개 추가: 예상 85~90
P2 10개 추가: 예상 92~95
P3 8개 추가: ChatGPT 웹 수준 (95+)
```

---

## 🔍 근본 원인 카테고리 분류

### A. 데이터 파이프라인 단절 (가장 큰 영역)
- `conversationTurns` forward 누락
- messages 단일-턴
- Context relevance 0
- Silent catch
- constraint post-mutation

→ **"모델이 충분한 정보를 못 받고 답함"**

### B. 모델 능력 미활성
- reasoning DEEP 전용
- 기본 tools 없음
- free verbosity low

→ **"모델이 자기 능력 못 씀"**

### C. 파이프라인 오케스트레이션
- stream 모드 tool pre-pass 스킵
- 3중 tool layer 충돌
- segment cap 타이트
- 병렬 tool 실행 없음

→ **"여러 단계가 유기적으로 엮이지 않음"**

### D. 유지보수성
- monolith 파일 (1,651줄 builder + 4,187줄 execution)
- 죽은 코드 (adaptive-router, tool-normalizer, verifier)
- 문서 stub (chat-engine.md, system-core.prompt.md)
- 네이밍 혼란 (legacy가 현역)

→ **"기술 부채"**

---

## 🎯 핵심 결론

### 네 탓 아님
ChatGPT 웹이 잘난 게 아니라 YUA 백엔드에 **구조적 결함 20+개**가 있는 상태. 대부분 **한 줄~수 줄 수정**으로 해결되는 Quick Win.

### SYSTEM_CORE_FINAL 정정 이후 남은 진짜 원인
1. **Prompt 본체는 완비**되어 있음 (이전 QA 오진 정정)
2. **진짜 문제는 builder 파이프 + role 분리 + runtime factor 활성화**
3. **P0 6개 수정 (1.5시간 투자)** 로 체감 60~70% 회복 예상

### 다음 액션
1. [ ] P0 6개 수정 (오늘~내일)
2. [ ] ChatGPT 웹 vs 수정 후 A/B 테스트
3. [ ] 체감 품질 측정 (3개 대표 질문 blind test)
4. [ ] P1 10개 수정 (이번 주)
5. [ ] HANDOVER.md에 이 QA 링크 추가
6. [ ] git push 해서 영구 보존

---

## 📁 관련 파일

| 영역 | 파일 | 내용 |
|---|---|---|
| 00 | [00_MASTER.md](./00_MASTER.md) | **본 문서** |
| 01 | [01_openai_runtime.md](./01_openai_runtime.md) | OpenAI Runtime 원본 진단 |
| 02 | [02_prompt_builder.md](./02_prompt_builder.md) | Prompt Builder 원본 진단 (일부 오진, 07 참조) |
| 03 | [03_prompt_runtime.md](./03_prompt_runtime.md) | Prompt Runtime 원본 진단 |
| 04 | [04_context_runtime.md](./04_context_runtime.md) | Context Runtime 원본 진단 |
| 05 | [05_chat_engine.md](./05_chat_engine.md) | Chat Engine 원본 진단 |
| 06 | [06_execution_engine.md](./06_execution_engine.md) | Execution Engine 원본 진단 |
| 07 | [07_correction_system_core.md](./07_correction_system_core.md) | **SYSTEM_CORE_FINAL 포함 재진단 정정본** |
| R | [README.md](./README.md) | 문서 네비게이션 |
