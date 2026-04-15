import fs from "fs";
import path from "path";
import { pgPool } from "../../db/postgres";

type GateResult = {
  name: string;
  pass: boolean;
  detail: string;
};

const REQUIRED_TABLES = [
  "audit_outbox",
  "admin_idempotency_keys",
  "admin_kpi_hourly",
  "admin_kpi_daily",
  "billing_verification_log",
  "credit_ledger",
  "usage_daily_summary",
  "usage_monthly_summary",
  "incident_timeline",
  "feature_flags",
  "feature_flag_audit",
  "security_event_log",
  "data_subject_request",
];

const REQUIRED_ROUTE_SNIPPETS = [
  '"/overview/kpi"',
  '"/billing/verification-logs"',
  '"/billing/credit-ledger"',
  '"/billing/credits/adjust"',
  '"/feature-flags"',
  '"/incidents"',
  '"/security/events"',
  '"/data-subject-requests"',
];

async function checkTables(): Promise<GateResult> {
  const { rows } = await pgPool.query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname='public' AND tablename = ANY($1::text[])
     ORDER BY tablename`,
    [REQUIRED_TABLES]
  );
  const found = new Set(rows.map((r: any) => r.tablename));
  const missing = REQUIRED_TABLES.filter((t) => !found.has(t));
  return {
    name: "required_tables",
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : `ok (${REQUIRED_TABLES.length})`,
  };
}

async function checkUniqueConstraints(): Promise<GateResult> {
  const { rows } = await pgPool.query(
    `SELECT
      tc.table_name,
      string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'UNIQUE'
       AND tc.table_schema = 'public'
       AND tc.table_name IN ('admin_idempotency_keys', 'credit_ledger')
     GROUP BY tc.table_name, tc.constraint_name`
  );

  const got = new Set(rows.map((r: any) => `${r.table_name}:${r.cols}`));
  const need = [
    "admin_idempotency_keys:scope,key_hash",
    "credit_ledger:idempotency_key",
  ];
  const missing = need.filter((n) => !got.has(n));
  return {
    name: "unique_constraints",
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(" | ")}` : "ok",
  };
}

async function checkIdempotencyBehavior(): Promise<GateResult> {
  const client = await pgPool.connect();
  const scope = "qa_gate_scope";
  const keyHash = "qa_gate_hash";
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM admin_idempotency_keys WHERE scope = $1 AND key_hash = $2`,
      [scope, keyHash]
    );
    const first = await client.query(
      `INSERT INTO admin_idempotency_keys (scope, key_hash, request_fingerprint, expires_at)
       VALUES ($1, $2, 'fp1', NOW() + INTERVAL '1 hour')
       ON CONFLICT (scope, key_hash) DO NOTHING
       RETURNING id`,
      [scope, keyHash]
    );
    const second = await client.query(
      `INSERT INTO admin_idempotency_keys (scope, key_hash, request_fingerprint, expires_at)
       VALUES ($1, $2, 'fp1', NOW() + INTERVAL '1 hour')
       ON CONFLICT (scope, key_hash) DO NOTHING
       RETURNING id`,
      [scope, keyHash]
    );
    await client.query("ROLLBACK");

    const pass = first.rowCount === 1 && second.rowCount === 0;
    return {
      name: "idempotency_behavior",
      pass,
      detail: pass ? "ok" : `unexpected rowCount first=${first.rowCount} second=${second.rowCount}`,
    };
  } catch (err: any) {
    await client.query("ROLLBACK");
    return { name: "idempotency_behavior", pass: false, detail: err?.message ?? "unknown error" };
  } finally {
    client.release();
  }
}

function checkRouteDefinitions(): GateResult {
  const filePath = path.resolve(__dirname, "../../routes/admin-router.ts");
  const text = fs.readFileSync(filePath, "utf8");
  const missing = REQUIRED_ROUTE_SNIPPETS.filter((snippet) => !text.includes(snippet));
  return {
    name: "admin_route_definitions",
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : "ok",
  };
}

async function main() {
  const results: GateResult[] = [];
  try {
    results.push(await checkTables());
    results.push(await checkUniqueConstraints());
    results.push(await checkIdempotencyBehavior());
    results.push(checkRouteDefinitions());
  } finally {
    await pgPool.end();
  }

  let failed = 0;
  console.log("=== Unified Admin Gate ===");
  for (const r of results) {
    const marker = r.pass ? "[PASS]" : "[FAIL]";
    if (!r.pass) failed += 1;
    console.log(`${marker} ${r.name} - ${r.detail}`);
  }

  if (failed > 0) {
    console.error(`Gate failed: ${failed} checks failed`);
    process.exit(1);
  }
  console.log("Gate passed: all checks green");
}

main().catch((err) => {
  console.error("Gate execution failed:", err);
  process.exit(1);
});

