# YUA Backend QA Findings — 2026-04-22

**진단 일자**: 2026-04-22
**대상 레포**: yuaone/yua-backend
**진단 방식**: 6개 병렬 QA 에이전트 투입 + 통합 분석
**사용자 문제 인식**: ChatGPT 웹 UI vs 자체 API wrapper (gpt-5.4) 답변 품질 격차 체감

---

## 📁 파일 구조

| # | 파일 | 내용 |
|---|---|---|
| 00 | [00_MASTER.md](./00_MASTER.md) | **통합 진단 + 수정 로드맵 (P0~P3)** |
| 01 | [01_openai_runtime.md](./01_openai_runtime.md) | OpenAI Runtime 에이전트 원본 |
| 02 | [02_prompt_builder.md](./02_prompt_builder.md) | Prompt Builder (5종) 에이전트 원본 |
| 03 | [03_prompt_runtime.md](./03_prompt_runtime.md) | Prompt Runtime 에이전트 원본 |
| 04 | [04_context_runtime.md](./04_context_runtime.md) | Context Runtime 에이전트 원본 |
| 05 | [05_chat_engine.md](./05_chat_engine.md) | Chat Engine 에이전트 원본 |
| 06 | [06_execution_engine.md](./06_execution_engine.md) | Execution Engine 에이전트 원본 |
| 07 | [07_correction_system_core.md](./07_correction_system_core.md) | **SYSTEM_CORE_FINAL 포함 재진단 정정본** ★|

---

## 🎯 핵심 발견 (요약)

### 치명상 상위 10개
1. **`conversationTurns` 6군데 forward 누락** — 매 턴 새 세션처럼 동작 (단독 최대 원인)
2. **reasoning DEEP 전용** — NORMAL/SEARCH/BENCH/RESEARCH에서 off
3. **기본 tools 자동 주입 없음** — web_search·code_interpreter 런타임 부재
4. **System prompt 5배 미달** — 400~900 토큰 vs ChatGPT 웹 5,000~8,000 토큰
5. **Identity 블록 부재** — 메인 빌더에 YUA 정체성 0건 (Lite에만 2줄)
6. **출력 포맷 규약 0건** — markdown·code·length 지시 전무
7. **Relevance ranking 0** — scope weight만, 임베딩 유사도 없음
8. **messages 단일-턴 구조** — `[system, user]`만, 이전 assistant 턴 주입 안 됨
9. **stream 모드 tool pre-pass 스킵** — 사용자는 항상 stream 쓰는데 context 수집 우회
10. **병렬 tool 실행 없음** — `await` 직렬 → 웹 UI 대비 3배 느림

---

## 🚀 P0 수정 (1시간 30분, 체감 60~70% 해소)

| 작업 | 시간 |
|---|---|
| `conversationTurns` forward 6군데 | 30분 |
| reasoning 기본 활성화 | 5분 |
| 기본 tools 자동 주입 | 10분 |
| free verbosity medium | 2분 |
| stream 모드 tool pre-pass 실행 | 30분 |
| SSOT violation fallback | 15분 |

**상세 수정 코드는 [00_MASTER.md](./00_MASTER.md) 참조.**

---

## 📊 격차 원인 총 20개

[00_MASTER.md](./00_MASTER.md) Section 3 참조.

---

## 🔒 민감도

이 문서는 내부 엔지니어링 허점을 기록함. **private 레포 유지 권장**. 공개 시 공격 벡터 제공 위험 (특히 Sandbox 우회 허점, Tool 스키마 drift).

---

## ⚙️ 다음 액션

1. [ ] P0 6개 수정 (오늘~내일)
2. [ ] ChatGPT 웹 vs 수정 후 품질 A/B 테스트
3. [ ] P1 수정 착수 (이번 주)
4. [ ] HANDOVER.md에 이 QA 링크 추가
