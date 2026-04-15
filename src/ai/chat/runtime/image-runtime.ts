// 📂 src/ai/chat/runtime/image-runtime.ts
// 🔒 ImageRuntime — Passthrough for image observation results

import type { ExecutionRuntimeResult } from "../../execution/execution-router";

export const ImageRuntime = {
  run(input: {
    observation: unknown;
  }): ExecutionRuntimeResult {
    const { observation } = input;

    try {
      return {
        ok: true,
        output: {
          kind: "IMAGE_OBSERVATION",
          context: observation,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "IMAGE_RUNTIME_ERROR",
          message: "ImageRuntime execution failed",
          detail: err,
        },
      };
    }
  },
};
