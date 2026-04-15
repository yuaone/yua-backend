// 📂 src/router/path-to-chatmode.ts
// 🔥 SSOT: Path → ChatMode 매핑 (THINK 완전 제거)

import type { PathType } from "./path-router";
import type { ChatMode } from "../ai/chat/types/chat-mode";

export function mapPathToChatMode(path: PathType): ChatMode {
  switch (path) {
    case "FAST":
      return "FAST";

    case "BENCH":
      return "BENCH";

    case "SEARCH":
      return "SEARCH";

    case "RESEARCH":
      return "RESEARCH";

    case "DEEP":
      return "DEEP";

    case "NORMAL":
    default:
      return "NORMAL";
  }
}
