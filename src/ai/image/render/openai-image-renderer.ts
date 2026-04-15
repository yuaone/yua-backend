// src/ai/image/render/openai-image-renderer.ts

import OpenAI from "openai";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type { SceneGraph } from "../scene/scene-builder";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const LOCAL_ASSET_ROOT = "/mnt/yua/assets";
const MAX_RETRIES = 2;

/* --------------------------------------------------
   스타일별 프롬프트 프리픽스 (SSOT)
   - LLM이 executionPlan.payload.imageStyle로 결정
   - 미지정 시 기본값 photorealistic
-------------------------------------------------- */
export type ImageStyle = "photorealistic" | "illustration" | "diagram";

const STYLE_PREFIX: Record<ImageStyle, string> = {
  photorealistic: `MANDATORY STYLE: Photorealistic photography.
This MUST look like a real photograph taken with a DSLR camera.
DO NOT render as anime, cartoon, illustration, CGI, or digital art.
DO NOT use bright neon colors, cel-shading, or stylized proportions.
Use natural skin tones, realistic fabric textures, and photographic lighting.
If the subject is a person, render as a real human being with natural features.`,

  illustration: `STYLE: Clean digital illustration with professional quality.
Vibrant colors, smooth gradients, expressive character design.
Suitable for mascots, characters, icons, and creative artwork.`,

  diagram: `STYLE: Technical diagram or infographic.
Clean lines, minimal design, professional color palette.
Use labels and arrows where appropriate.
White or light gray background. No decorative elements.`,
};

function buildImagePrompt(scene: SceneGraph, style: ImageStyle): string {
  const prefix = STYLE_PREFIX[style];
  const description = scene.entities
    .map((e) => e.attributes?.description ?? e.type)
    .join(". ");

  return `${prefix}

SCENE: ${description}

HARD CONSTRAINTS:
- Anatomically correct human proportions (if applicable)
- Correct number of fingers on each hand (5)
- No twisted limbs or broken joints
- Sharp focus, clean lighting
- No motion blur or abstract distortion
- Professional, production-quality output

If any constraint cannot be satisfied, generate the closest valid image
without introducing distortions.`;
}

/* --------------------------------------------------
   재시도 래퍼 (429/500 방어)
-------------------------------------------------- */
async function generateWithRetry(
  params: Parameters<typeof client.images.generate>[0],
  retries = MAX_RETRIES
): Promise<any> {
  try {
    return await client.images.generate(params);
  } catch (err: any) {
    if (retries > 0 && (err?.status === 429 || err?.status === 500)) {
      console.warn("[IMAGE][RETRY]", { retriesLeft: retries, status: err.status });
      await new Promise((r) => setTimeout(r, 1000 * (MAX_RETRIES - retries + 1)));
      return generateWithRetry(params, retries - 1);
    }
    throw err;
  }
}

/* --------------------------------------------------
   메인 렌더러
-------------------------------------------------- */
export async function renderSemanticImage(
  scene: SceneGraph,
  opts?: {
    style?: ImageStyle;
    size?: "1024x1024" | "1024x1792" | "1792x1024";
  }
): Promise<{
  url: string;
  hash: string;
}> {
  const style = opts?.style ?? "photorealistic";
  const size = opts?.size ?? "1024x1024";

  console.log("[IMAGE][SEMANTIC][ENTER]", { style, size });

  const prompt = buildImagePrompt(scene, style);

  console.log("[IMAGE][SEMANTIC][OPENAI_REQUEST]", {
    promptLength: prompt.length,
    style,
  });

  const result = await generateWithRetry({
    model: "gpt-image-1",
    prompt,
    size,
  });

  const image = result.data?.[0];

  if (!image?.b64_json) {
    console.error("[IMAGE][SEMANTIC][OPENAI_EMPTY_RESULT]", {
      hasData: Boolean(result.data),
      firstItem: image,
    });
    throw new Error("OPENAI_IMAGE_GENERATION_FAILED");
  }

  console.log("[IMAGE][SEMANTIC][OPENAI_OK]");

  // 1️⃣ base64 → buffer
  const buffer = Buffer.from(image.b64_json, "base64");

  // 2️⃣ content hash (SSOT / dedupe key)
  const hash = crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");

  // 3️⃣ local path
  const dir = path.join(LOCAL_ASSET_ROOT, "semantic");
  const filePath = path.join(dir, `${hash}.png`);

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, buffer);
  } catch (err) {
    console.error("[IMAGE][SEMANTIC][WRITE_FAIL]", { filePath, error: String(err) });
    throw err;
  }

  const url = `file://${filePath}`;

  console.log("[IMAGE][SEMANTIC][DONE]", { url, hash, sizeBytes: buffer.length });

  return { url, hash };
}
