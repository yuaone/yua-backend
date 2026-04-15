// yua-backend/src/scripts/embed-messages.ts
// Batch embed all chat_messages that don't have embeddings yet.
// Uses local /v1/embed endpoint (yua-python, multilingual-e5-large-instruct).
//
// Usage: npx tsx src/scripts/embed-messages.ts
// Or:    node dist/scripts/embed-messages.js

import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { pgPool } from "../db/postgres.js";

const EMBED_URL = process.env.PYTHON_RUNTIME_URL || "http://127.0.0.1:5100";
const BATCH_SIZE = 5;  // 5 texts per call — CPU-only server, keep batches small
const MAX_TEXT_LEN = 512; // truncate long messages

interface EmbedResponse {
  vectors: number[][];
  model: string;
  dim: number;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${EMBED_URL}/v1/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      texts,
      model: "intfloat/multilingual-e5-large-instruct",
      task: "passage",
      output_dim: 1024,
    }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status} ${await res.text()}`);
  const data: EmbedResponse = await res.json();
  return data.vectors;
}

async function main() {
  console.log("[EMBED] Starting batch message embedding...");

  // Get messages without embeddings
  const countRes = await pgPool.query(`
    SELECT COUNT(*) AS total FROM chat_messages cm
    WHERE NOT EXISTS (SELECT 1 FROM message_embeddings me WHERE me.message_id = cm.id)
      AND LENGTH(cm.content) > 10
  `);
  const total = Number(countRes.rows[0].total);
  console.log(`[EMBED] ${total} messages to embed`);

  if (total === 0) {
    console.log("[EMBED] Nothing to do.");
    process.exit(0);
  }

  let processed = 0;
  let errors = 0;

  while (true) {
    // Fetch batch of unembedded messages
    const batch = await pgPool.query<{ id: number; thread_id: number; content: string }>(`
      SELECT cm.id, cm.thread_id, cm.content
      FROM chat_messages cm
      WHERE NOT EXISTS (SELECT 1 FROM message_embeddings me WHERE me.message_id = cm.id)
        AND LENGTH(cm.content) > 10
      ORDER BY cm.id ASC
      LIMIT $1
    `, [BATCH_SIZE]);

    if (batch.rows.length === 0) break;

    const texts = batch.rows.map(r =>
      r.content.length > MAX_TEXT_LEN ? r.content.slice(0, MAX_TEXT_LEN) : r.content
    );

    try {
      const vectors = await embedTexts(texts);

      // Bulk insert
      const values: string[] = [];
      const args: unknown[] = [];
      let idx = 1;

      for (let i = 0; i < batch.rows.length; i++) {
        const row = batch.rows[i];
        const vec = vectors[i];
        if (!vec || vec.length !== 1024) {
          errors++;
          continue;
        }
        values.push(`($${idx}, $${idx + 1}, $${idx + 2}::vector)`);
        args.push(row.id, row.thread_id, `[${vec.join(",")}]`);
        idx += 3;
      }

      if (values.length > 0) {
        await pgPool.query(`
          INSERT INTO message_embeddings (message_id, thread_id, embedding)
          VALUES ${values.join(", ")}
          ON CONFLICT (message_id) DO NOTHING
        `, args);
      }

      processed += batch.rows.length;
      console.log(`[EMBED] ${processed}/${total} (${errors} errors)`);
    } catch (e) {
      console.error(`[EMBED] Batch error:`, (e as Error).message);
      errors += batch.rows.length;
      // Continue with next batch
    }
  }

  console.log(`[EMBED] Done. ${processed} embedded, ${errors} errors.`);

  // Rebuild IVFFlat index now that we have data
  try {
    console.log("[EMBED] Rebuilding IVFFlat index...");
    await pgPool.query("REINDEX INDEX idx_msg_embed_vec");
    console.log("[EMBED] Index rebuilt.");
  } catch (e) {
    console.warn("[EMBED] Index rebuild failed (non-critical):", (e as Error).message);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("[EMBED] Fatal:", e);
  process.exit(1);
});
