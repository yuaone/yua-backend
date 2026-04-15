// src/ai/mop/mop-experts.ts
// MoP: Mixture of Prompt Experts — Expert Pool Definition
// Author: 정원 (YUA founder)
//
// Each expert = a group of related tools + trigger patterns.
// The MoP gate activates only relevant experts per request,
// reducing tool token injection from ~5K to ~300 tokens.

export interface MopExpert {
  id: string;
  name: string;
  description: string;          // for embedding similarity gate
  toolProviders: string[];      // MCP provider names (e.g. "huggingface")
  nativeTools?: string[];       // native tool names (e.g. "code_execute")
  keywordPatterns: RegExp[];    // Tier 1: keyword matching
  alwaysActive?: boolean;       // Expert 0 is always active
  maxTools?: number;            // limit tools from this expert
}

/**
 * Expert 0: CORE — always active, minimal overhead
 * These tools are needed in almost every conversation.
 */
const CORE: MopExpert = {
  id: "core",
  name: "Core",
  description: "Basic tools: artifact creation, memory, code execution",
  toolProviders: [],
  nativeTools: [
    "artifact_create",
    "artifact_update",
    "memory_append",
    "activate_skill",
    "code_execute",
    "analyze_image",
    "analyze_csv",
    "quant_analyze",
  ],
  keywordPatterns: [],
  alwaysActive: true,
};

/**
 * Expert 1: HUGGINGFACE — datasets, models, papers
 */
const HUGGINGFACE: MopExpert = {
  id: "huggingface",
  name: "Hugging Face",
  description: "Search and explore HuggingFace datasets, models, papers, and spaces",
  toolProviders: ["huggingface"],
  keywordPatterns: [
    /허깅페이스|hugging\s?face|hf\b/i,
    /데이터셋|dataset/i,
    /모델\s*검색|model\s*search/i,
    /파인튜닝|fine.?tun/i,
    /트랜스포머|transformer/i,
    /논문\s*검색|paper\s*search|arxiv/i,
  ],
};

/**
 * Expert 2: GITHUB — repos, issues, PRs, code search
 */
const GITHUB: MopExpert = {
  id: "github",
  name: "GitHub",
  description: "GitHub repository management: issues, pull requests, code search, branches",
  toolProviders: ["github"],
  keywordPatterns: [
    /깃허브|github/i,
    /레포지?토리|repository|repo\b/i,
    /이슈|issue/i,
    /풀\s*리퀘스트|pull\s*request|PR\b/i,
    /커밋|commit/i,
    /브랜치|branch/i,
    /코드\s*검색|search\s*code/i,
  ],
  maxTools: 15, // GitHub has 41 tools, limit to most useful
};

/**
 * Expert 3: GOOGLE WORKSPACE — Gmail, Drive, Calendar
 */
const GOOGLE_WORKSPACE: MopExpert = {
  id: "google_workspace",
  name: "Google Workspace",
  description: "Gmail email, Google Drive files, Google Calendar events and scheduling",
  toolProviders: ["gmail", "gdrive", "google_calendar"],
  keywordPatterns: [
    /메일|이메일|email|gmail|편지|inbox|받은\s*편지|보낸\s*편지|답장|전달|forward|reply/i,
    /드라이브|drive|구글\s*문서|파일\s*찾|문서\s*검색|공유\s*문서|shared\s*doc/i,
    /캘린더|calendar|일정|스케줄|약속|예약|appointment|schedule/i,
    /회의|미팅|meeting/i,
    /첨부|attachment/i,
  ],
};

/**
 * Expert 4: SEARCH — Context7 docs, web search
 */
const SEARCH: MopExpert = {
  id: "search",
  name: "Search & Docs",
  description: "Search documentation, libraries, frameworks. Web search for current information",
  toolProviders: ["context7"],
  keywordPatterns: [
    /검색해\s*줘|찾아\s*줘|search\s+(for|docs|documentation)/i,
    /공식\s*문서|documentation|docs\s*(확인|찾|검색)/i,
    /라이브러리\s*(문서|검색|사용법)|framework\s*(docs|guide)/i,
    /어떻게\s*설치|설치\s*방법|install\s*guide/i,
    /사용법\s*알려|usage\s*guide|getting\s*started/i,
    /context7|컨텍스트7/i,
  ],
};

/**
 * Expert 5: CODE INTERPRETER — Python execution with package list
 */
const CODE_INTERPRETER: MopExpert = {
  id: "code_interpreter",
  name: "Code Interpreter",
  description: "Execute Python code, generate charts, analyze data, mathematical computation",
  toolProviders: [],
  nativeTools: [],  // code_execute is already in CORE (alwaysActive)
  keywordPatterns: [
    /파이썬\s*(코드|실행|스크립트)|python\s*(code|run|script)/i,
    /코드\s*(실행|돌려|짜|작성)/i,
    /계산\s*(해|좀)|calculate|compute/i,
    /그래프\s*(그려|만들)|chart|plot|시각화/i,
    /데이터\s*분석|data\s*analy/i,
    /엑셀|csv|pandas|jupyter/i,
  ],
};

/**
 * All experts in order of priority
 */
export const MOP_EXPERTS: MopExpert[] = [
  CORE,           // 0: always active
  HUGGINGFACE,    // 1
  GITHUB,         // 2
  GOOGLE_WORKSPACE, // 3
  SEARCH,         // 4
  CODE_INTERPRETER, // 5
];

/**
 * Get expert by ID
 */
export function getExpertById(id: string): MopExpert | undefined {
  return MOP_EXPERTS.find(e => e.id === id);
}
