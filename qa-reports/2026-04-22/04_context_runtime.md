# 04. Context Runtime QA 원본 진단

**주 파일**: `src/ai/chat/runtime/context-runtime.ts` (522줄)

**연계 참조**:
- `src/ai/context/context-merger.ts` (139줄)
- `src/ai/context/buildConversationContext.ts` (110줄)
- `src/ai/context/conversation-turn-semantic.ts` (227줄)
- `src/ai/context/conversation-summary-engine.ts` (261줄)
- `src/ai/context/loadConversationContext.ts` (26줄)
- `src/ai/context/updateConversationSummary.ts` (54줄)

---

## 1. 컨텍스트 로드 소스

**단일 PostgreSQL 기반**.

- `buildConversationContext`가 `fetchRecentChatMessages`(최근 20개)와 `fetchConversationSummary`(DEEP 모드 요약)를 Postgres에서 병렬 로드(`buildConversationContext.ts:53-56`).
- 그다음 `loadUnifiedMemory`로 user/project/cross-thread 컨텍스트를 같은 DB에서 당긴다(`context-runtime.ts:374-380`).
- **벡터 DB, 임베딩 스토어, RAG 인덱스는 호출부에 전혀 없다.**
- 우선순위는 conversation → user → crossThread → architecture → decision 순으로 memoryChunks 배열에 push되고(`context-runtime.ts:444-450`), 실제 정렬은 merger의 scope weight(summary 3 > general 2 > domain/personal 1.5)에 위임된다.

## 2. 토큰 예산 관리

하드코딩 한 줄: `MAX_CONTEXT_CHARS = 12000` 으로 단순 슬라이스 후 `[...truncated]` 접미사(`context-runtime.ts:502-506`).

- **FIFO/LRU/priority 없이 char-suffix truncation.**
- `MAX_CONVERSATION_CHUNKS=11`, `MAX_MEMORY_CHUNKS=8`도 정의만 있고 실제로는 `conversationChunks.push`에 적용되지 않음(`context-runtime.ts:337`).
- 결과적으로 후순위 청크가 잘려서 가장 중요한 architecture/decision이 먼저 탈락할 위험.

## 3. Relevance Ranking

검색 결과만 점수화(`context-merger.ts:56-60`, `relevance*0.6 + trust/5*0.4`).

- memory/conversation은 **scope 기반 가중치**(정적 상수)만 존재하고 유사도 계산 없음(`context-merger.ts:78-91`).
- 질문 본문과 청크의 의미적 관련도는 측정하지 않는다.
- **BM25, 임베딩, cosine 유사도 전무.**

## 4. 사용자 프로필·선호 통합

- `loadUnifiedMemory`가 userContext를 반환하면 personal scope로 1청크 삽입(`context-runtime.ts:383-388`).
- `isSelfInquiry===true`일 때만 `MemoryManager.getSelfMemory`로 헌법 key만 constraint에 주입(토큰 절감 목적, `context-runtime.ts:101-118`).
- 선호 프로필은 loadUnifiedMemory 내부에 감춰져 있어 이 런타임 레벨에서는 가시성 없음.
- 선호도 명시 스키마(likes/dislikes/tone) 없음.

## 5. 대화 이력 summarization

- `ConversationSummaryEngine.updateIfNeeded`가 **DEEP 모드 + assistantOutput 500자 이상**일 때만 발동(`conversation-summary-engine.ts:46-75`).
- FAST/NORMAL/SEARCH/RESEARCH 모드는 요약 생성 안 됨 → **긴 일반 대화는 summarization 누락**.
- `updateConversationSummary`(legacy, 12턴 미만 skip)와 로직 중복.
- Checkpoint 개념 없고 thread당 single row upsert.

## 6. 외부 지식 주입

- `searchResults` 배열을 인자로 받아 merger에서 `isOfficialDocSource` 필터 후 trustedFacts 문자열로 합침(`context-merger.ts:54-66`).
- 시간 민감도(freshness, TTL) 플래그 없음.
- **RAG 파이프라인·벡터 검색·실시간 web 결과 fetch 없음.**
- 호출자가 외부에서 searchResults를 주입해야만 동작 → 계층 책임 분리는 깔끔하나 자체 트리거 불가.

## 7. Context Invalidation

**없다시피 함**.

- `isGeneratedExplanation` 정규식(`단계별|절차|요약하면...`)으로 LLM이 생성한 설명문을 감지해 carryLevel을 ENTITY로 **약화**할 뿐 폐기는 안 함(`context-runtime.ts:43-47, 321-326, 475-478`).
- 같은 체크가 316과 475에 중복.
- TTL, 버전 stale 체크, 사실 충돌 감지 로직 부재.
- `SHIFT` intent도 "state 삭제 안 함"으로 명시(`context-runtime.ts:238-239`) → **stale 컨텍스트 축적**.

## 8. Race Condition / Concurrent Access

- **락/트랜잭션 없음**.
- `ThreadSemanticStateRepository.get`과 `buildConversationContext`가 독립 DB 호출이고 summary upsert는 `ON CONFLICT DO UPDATE`라 **last-writer-wins**(`conversation-summary-engine.ts:199-217`).
- 같은 threadId로 두 요청이 동시에 들어오면 summary version 덮어쓰기·context 미스매치 가능.
- `console.log`로만 추적 가능하며 traceId 일관성 없음.

## 9. ChatGPT 웹 대비 결핍

1. **Cross-session vector recall**: 웹은 임베딩 기반으로 과거 수백 세션에서 관련 발화를 꺼내오지만 여기는 thread 단위 + scope 기반 SQL SELECT.
2. **Auto memory extraction**: 웹은 "사용자가 X를 선호한다"를 실시간 추출; 여기는 DEEP 모드 후 배치 요약만.
3. **Tool/file attachment persistence**: meta.tool_context 주입은 있으나(`buildConversationContext.ts:74-76`) 첨부 파일/이미지 영속 참조 없음.
4. **Forgetting mechanism**: 웹은 사용자가 특정 기억 삭제 가능; invalidation 로직 자체가 없음.
5. **Adaptive context window**: 웹은 모델·요청 타입별 동적 예산; 여기는 12000 고정.

## 10. 품질 저하 원인 TOP 5

### 1. `context-runtime.ts:502-506` 하드 char 기반 truncation
토큰≠문자, 한국어/이모지 기준 과소추정.
**개선**: tiktoken 기반 토큰 카운트 + priority queue로 낮은 weight부터 drop.

### 2. `context-merger.ts:78-91` scope-only 가중치
질문과의 관련도 0% 반영, 오래된 personal 청크가 최신 domain 청크를 누를 수 있음.
**개선**: userMessage 임베딩 vs 청크 임베딩 cosine 추가(간이 BM25도 가능).

### 3. `context-runtime.ts:43-47` `isGeneratedExplanation` 정규식
"단계별/요약하면" 6개 키워드만으로 carryLevel을 ENTITY로 강등. false positive 심함(실제 분석글도 강등).
**개선**: LLM classifier 또는 tag 메타데이터 기반 판단.

### 4. `conversation-summary-engine.ts:46-48` DEEP 전용 요약
일반 대화는 20턴 넘으면 FIFO로 버려짐(`recentLimit=20`, `buildConversationContext.ts:50`).
**개선**: 모든 모드에서 sliding-window rolling summary + DEEP은 workspace 승격만 분리.

### 5. `context-runtime.ts:260-268` continuity를 anchorConfidence 임계값 0.35로만 결정
점수 가산이 0.55+0.45+0.35로 천장에 자주 부딪혀 변별력 상실. `SHIFT` 시 state 보존이라 topic drift 누적.
**개선**: 엔티티 overlap·시간 감쇠 함수 도입, SHIFT 시 semanticState.activeTopic 명시적 rotate.

---

## 핵심 결론

현재 구조는 "SQL scope + 정규식 heuristic + char truncation" 조합으로 **ChatGPT 대비 relevance ranking·vector recall·adaptive budget·forgetting이 전부 빠져 있음**.

답변이 파편적이 되는 근본 원인은:
- (a) 의미 유사도 기반 selection 부재
- (b) DEEP 외 모드 summarization 누락
- (c) continuation 점수 saturation

세 가지.
