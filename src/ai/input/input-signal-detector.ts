// 🔒 INPUT SIGNAL DETECTOR — SSOT FINAL (PHASE 6-2)
// -----------------------------------------------
// 책임:
// - 사용자 입력에서 "행동 신호"만 추출
//
// 금지:
// - 추론 ❌
// - 판단 ❌
// - async ❌
// - LLM ❌
//
// 출력은 TaskResolver / ExecutionDispatcher만 사용

export interface InputSignals {
  hasImage: boolean;
  hasCodeBlock: boolean;
  hasCodeIntent: boolean;
  hasErrorLog: boolean;
}

/* --------------------------------------------------
   🔒 CODE INTENT PATTERNS (코드 블록 없어도 코드 요청 감지)
   - 언어/프레임워크 명시, 코드 생성 키워드, 기능 구현 요청
   - hasCodeBlock과 독립 (둘 다 true 가능)
-------------------------------------------------- */
const CODE_INTENT_PATTERNS: RegExp[] = [
  // KO: 코드/함수/클래스 + 생성 동사
  /(코드|함수|클래스|컴포넌트|모듈|API|스크립트|엔드포인트|서버|라우터|핸들러).{0,10}(짜|만들|작성|구현|생성|개발|추가)/i,
  /(짜줘|만들어|작성해|구현해|생성해|개발해|추가해).{0,15}(코드|함수|클래스|컴포넌트|모듈|API|스크립트)/i,
  // KO: 알고리즘/자료구조 + 생성 동사
  /(알고리즘|정렬|탐색|재귀|DP|그래프|큐|스택|트리|해시).{0,10}(짜|구현|만들|작성)/i,
  // KO: 기능/시스템 + 생성 동사
  /(기능|feature|서비스|시스템|페이지|화면|폼|테이블|크롤러|봇|스크래퍼|파서|CLI|도구|툴).{0,10}(구현|만들|작성|개발|추가)/i,
  /(구현|만들|작성|개발|추가).{0,15}(기능|feature|서비스|시스템|페이지|화면|크롤러|봇|스크래퍼|파서|CLI|도구|툴)/i,
  // KO: 리팩토링/리뷰
  /(리팩토링|리뷰|코드\s*리뷰|코드\s*검토|코드\s*최적화)/i,
  // EN: code generation (verb + object)
  /(write|create|implement|build|develop|make|code)\s+(a\s+)?(function|class|component|module|script|api|endpoint|server|handler|hook|service|route|middleware)/i,
  /(create|build|implement|make|write)\s+(a\s+)?(rest|http|graphql|websocket|grpc)?\s*(api|endpoint|server|route)/i,
  /(function|class|component|module|script|api|endpoint)\s+(that|which|to)\s/i,
  // EN: algorithm (verb + concept)
  /(implement|write|create|build|code)\s+(a\s+)?(sorting|search|binary|recursive|dynamic|graph|tree|hash|queue|stack)/i,
  /(sorting|search|recursive|dynamic programming|binary tree|binary search|graph)\s+(algorithm|function|implementation)/i,
  // 언어 명시 + 동사 (강한 신호)
  /\b(python|javascript|typescript|java|go|rust|c\+\+|ruby|swift|kotlin)\b.{0,20}(으로|로|에서|in|으로\s*(짜|만들|작성|구현))/i,
  // 프레임워크 명시 + 동사 (강한 신호)
  /\b(react|next\.?js|express|fastapi|django|spring|flutter|vue|svelte|nest\.?js)\b.{0,20}(으로|로|만들|구현|작성|짜)/i,
];

/**
 * Deterministic input signal detector
 */
export function detectInputSignals(args: {
  message: string;
  attachments?: unknown[];
}): InputSignals {
  const { message, attachments } = args;

  const text = message ?? "";

  /* ---------------------------------- */
  /* IMAGE                               */
  /* ---------------------------------- */
  const hasImage =
    Array.isArray(attachments) &&
    attachments.some(
      (a) => typeof a === "object" && (a as any).kind === "image"
    );

  /* ---------------------------------- */
  /* CODE BLOCK                          */
  /* ---------------------------------- */
  const hasCodeBlock =
    /```[\s\S]*?```/m.test(text) ||
    /(class |function |const |let |var |=>)/.test(text);

  /* ---------------------------------- */
  /* CODE INTENT (코드 블록 없어도)      */
  /* ---------------------------------- */
  const hasCodeIntent =
    CODE_INTENT_PATTERNS.some((r) => r.test(text));

  /* ---------------------------------- */
  /* ERROR LOG                           */
  /* ---------------------------------- */
  const hasErrorLog =
    /(error|exception|stack trace|ts\d{4}|TypeError|ReferenceError)/i.test(
      text
    );

  return {
    hasImage,
    hasCodeBlock,
    hasCodeIntent,
    hasErrorLog,
  };
}
