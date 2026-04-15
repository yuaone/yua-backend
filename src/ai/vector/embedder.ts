// src/ai/vector/embedder.ts
// SSOT — YUA embedding provider (Phase F: OpenAI → local dual mode)
import OpenAI from "openai";

const PYTHON_RUNTIME_URL = process.env.PYTHON_RUNTIME_URL || "http://127.0.0.1:5100";
const USE_LOCAL_EMBED = process.env.USE_LOCAL_EMBED === "1";
const LOCAL_DIM = 1024;
const OPENAI_DIM = 1536;
const DIM = USE_LOCAL_EMBED ? LOCAL_DIM : OPENAI_DIM;

export interface EmbeddingResult {
  ok: boolean;
  provider: "openai" | "local" | "fallback" | "empty";
  vector: number[];
  dim: number;
}

export type Embedder = {
  model: string;
  dim: number;
  embedTexts: (texts: string[]) => Promise<number[][]>;
};

function normalizeVector(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) {
    if (Number.isFinite(v)) sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) return vec;
  return vec.map((v) => (Number.isFinite(v) ? v / norm : 0));
}

/**
 * Local embedding via yua-python /v1/embed
 */
async function embedLocal(texts: string[], task = "passage"): Promise<number[][]> {
  const res = await fetch(`${PYTHON_RUNTIME_URL}/v1/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      texts,
      model: "intfloat/multilingual-e5-large-instruct",
      task,
      normalize: true,
    }),
  });
  if (!res.ok) throw new Error(`embed local failed: ${res.status}`);
  const data = await res.json();
  return data.vectors;
}

/**
 * SSOT embed function — routes to local or OpenAI based on env
 */
export async function embed(
  text: string,
  apiKey: string | undefined = process.env.OPENAI_API_KEY
): Promise<EmbeddingResult> {
  if (!text?.trim()) {
    return { ok: true, provider: "empty", vector: new Array(DIM).fill(0), dim: DIM };
  }

  // Phase F: try local first if enabled
  if (USE_LOCAL_EMBED) {
    try {
      const vectors = await embedLocal([text]);
      return {
        ok: true,
        provider: "local",
        vector: normalizeVector(vectors[0]),
        dim: LOCAL_DIM,
      };
    } catch (err) {
      console.warn("[EMBED] local failed, falling back to OpenAI:", (err as Error).message);
    }
  }

  // OpenAI fallback (or primary if USE_LOCAL_EMBED=0)
  try {
    const client = new OpenAI({ apiKey });
    const res = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    const embedding = res.data?.[0]?.embedding ?? [];
    const cleaned = embedding
      .map((n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0))
      .slice(0, OPENAI_DIM);
    while (cleaned.length < OPENAI_DIM) cleaned.push(0);
    return { ok: true, provider: "openai", vector: normalizeVector(cleaned), dim: OPENAI_DIM };
  } catch (err) {
    console.error("❌ embed fallback:", err);
    const fallback = new Array(DIM).fill(0).map((_, i) => {
      const code = text.charCodeAt(i % text.length);
      return Math.sin(code * 0.01 + i * 0.001) * 0.01;
    });
    return { ok: true, provider: "fallback", vector: normalizeVector(fallback), dim: DIM };
  }
}

export function createLocalEmbedder(): Embedder {
  return {
    model: "multilingual-e5-large-instruct",
    dim: LOCAL_DIM,
    embedTexts: async (texts: string[]) => {
      const vectors = await embedLocal(texts, "passage");
      return vectors.map(normalizeVector);
    },
  };
}

export function createOpenAIEmbedder(apiKey: string): Embedder {
  const client = new OpenAI({ apiKey });
  return {
    model: "text-embedding-3-small",
    dim: OPENAI_DIM,
    embedTexts: async (texts: string[]) => {
      const res = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: texts,
      });
      return res.data.map((d) =>
        normalizeVector(
          d.embedding.map((n) => (Number.isFinite(n) ? n : 0)).slice(0, OPENAI_DIM)
        )
      );
    },
  };
}
