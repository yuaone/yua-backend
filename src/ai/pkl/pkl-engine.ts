// 📂 src/ai/pkl/pkl-engine.ts
// 🔥 PKL 3.0 — FULL FIXED ENTERPRISE BUILD (2025.12)

// ----------------------------------------------------------
// TYPE SAFETY — 모든 외부 엔진과 완전 호환되도록 타입 재정의
// ----------------------------------------------------------
export interface CollapseInput {
  engine: "LITE" | "HPE" | "QUANTUM" | "BIZ" | "PATTERN" | "RISK" | "DEFAULT";
  text: string;
  confidence: number;
}

interface CollapseOutput {
  collapsed: string;
  finalConfidence: number;
}

interface SemanticResult {
  safe: boolean;
  cleaned: string;
  reason?: string;
}

interface RoutingResult {
  route: CollapseInput["engine"];
}

interface LitePipelineOutput {
  ok: boolean;
  engineInput?: string;
  reason?: string;
  metadata?: {
    stableConfidence?: number;
  };
}


interface BusinessResult {
  text?: string;
}

interface PatternResult {
  summary?: string;
  confidence?: number;
}

interface RiskResult {
  explanation?: string;
  level?: string;
}

// ----------------------------------------------------------
// IMPORTS
// ----------------------------------------------------------
import { runSemanticKernel } from "./semantic/semantic-kernel";
import { runDynamicRouting } from "./routing/dynamic-routing";
import { runCollapseKernel } from "./collapse/collapse-kernel";

import { runLitePipeline } from "../lite/pipeline-lite";
import { BusinessReportEngine } from "../engines/report-engine.business";
import { PatternEngine } from "../engines/pattern-engine";
import { RiskEngine } from "../engines/risk-engine";

// ----------------------------------------------------------
// PKL RESULT TYPE
// ----------------------------------------------------------
export interface PKLResult {
  ok: boolean;
  engine: "PKL3" | "pkl-semantic";
  message: string;
  routeUsed?: string;
  confidence?: number;
}

// ----------------------------------------------------------
// MAIN PKL3 ENGINE
// ----------------------------------------------------------
export async function runPKL(input: string): Promise<PKLResult> {
  // ------------------------------------------------------
  // 1) Semantic Kernel (전처리)
  // ------------------------------------------------------
  const semantic: SemanticResult = await runSemanticKernel(input);

  if (!semantic.safe) {
    return {
      ok: false,
      engine: "pkl-semantic",
      message: semantic.reason ?? "Semantic Kernel blocked",
    };
  }

  // ------------------------------------------------------
  // 2) Dynamic Routing
  // ------------------------------------------------------
  const routing: RoutingResult = runDynamicRouting(semantic.cleaned);

  const resultList: CollapseInput[] = [];

  // ------------------------------------------------------
  // 3) ROUTING HANDLERS
  // ------------------------------------------------------
  switch (routing.route) {
    // --------------------------------------------------
    case "LITE": {
      const lite: LitePipelineOutput = await runLitePipeline(semantic.cleaned);

      resultList.push({
        engine: "LITE",
        text: lite.engineInput ?? semantic.cleaned,
        confidence: lite.metadata?.stableConfidence ?? 0.7,
      });
      break;
    }

    // removed: HPE/Quantum/Spine legacy

    // --------------------------------------------------
    case "HPE":
    case "QUANTUM": {
      resultList.push({
        engine: routing.route as CollapseInput["engine"],
        text: semantic.cleaned,
        confidence: 0.7,
      });
      break;
    }

    // --------------------------------------------------
    case "BIZ": {
      const b: BusinessResult | string =
        await BusinessReportEngine.quickAnalyze({ message: semantic.cleaned });

      const bizText = typeof b === "string" ? b : b?.text ?? "";

      resultList.push({
        engine: "BIZ",
        text: bizText,
        confidence: 0.9,
      });
      break;
    }

    // --------------------------------------------------
    case "PATTERN": {
      const p: PatternResult = await PatternEngine.analyze(semantic.cleaned, {});

      resultList.push({
        engine: "PATTERN",
        text: p.summary ?? "",
        confidence: p.confidence ?? 0.65,
      });
      break;
    }

    // --------------------------------------------------
    case "RISK": {
      const r: RiskResult = await RiskEngine.analyzeRisk({
        text: semantic.cleaned,
      });

      resultList.push({
        engine: "RISK",
        text: r.explanation ?? r.level ?? "",
        confidence: 0.7,
      });
      break;
    }

    // --------------------------------------------------
    default:
      resultList.push({
        engine: "DEFAULT",
        text: semantic.cleaned,
        confidence: 0.7,
      });
      break;
  }

  // ------------------------------------------------------
  // 4) COLLAPSE STAGE
  // ------------------------------------------------------
  const collapsed: CollapseOutput = runCollapseKernel(resultList);

  // ------------------------------------------------------
  // 5) FINAL OUTPUT
  // ------------------------------------------------------
  return {
    ok: true,
    engine: "PKL3",
    routeUsed: routing.route,
    message: collapsed.collapsed,
    confidence: collapsed.finalConfidence,
  };
}
