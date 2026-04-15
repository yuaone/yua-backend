-- AI quality KPI views (phase9 raw events SSOT)

CREATE OR REPLACE VIEW ai_quality_daily_kpi AS
SELECT
  date_trunc('day', occurred_at) AS day,
  COUNT(*) AS events,
  COUNT(DISTINCT trace_id) FILTER (WHERE trace_id IS NOT NULL) AS traces,
  COUNT(*) FILTER (WHERE event_kind = 'message') AS message_events,
  COUNT(*) FILTER (WHERE event_kind = 'decision') AS decision_events,
  COUNT(*) FILTER (WHERE event_kind = 'execution') AS execution_events,
  COUNT(*) FILTER (
    WHERE payload::text ILIKE '%127.0.0.1:8017%'
      AND payload::text ILIKE '%ECONNREFUSED%'
  ) AS yua_max_v1_conn_refused,
  COUNT(*) FILTER (
    WHERE COALESCE(payload->>'model', payload->>'modelId', payload->>'engine') IS NOT NULL
      AND COALESCE(payload->>'model', payload->>'modelId', payload->>'engine') <> ''
  ) AS model_tagged_events,
  COUNT(*) FILTER (
    WHERE COALESCE(
      payload->>'content',
      payload->>'text',
      payload->>'answer',
      ''
    ) <> ''
  ) AS response_text_events,
  ROUND(100.0 * COUNT(*) FILTER (WHERE latency_ms IS NOT NULL) / NULLIF(COUNT(*), 0), 2)
    AS latency_fill_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE token_count IS NOT NULL) / NULLIF(COUNT(*), 0), 2)
    AS token_fill_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE verdict IS NOT NULL AND verdict <> '') / NULLIF(COUNT(*), 0), 2)
    AS verdict_fill_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE path IS NOT NULL AND path <> '') / NULLIF(COUNT(*), 0), 2)
    AS path_fill_rate_pct
FROM phase9_raw_event_log
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW ai_quality_recent_14d_kpi AS
SELECT
  COUNT(*) AS events_14d,
  COUNT(DISTINCT trace_id) FILTER (WHERE trace_id IS NOT NULL) AS traces_14d,
  COUNT(*) FILTER (
    WHERE payload::text ILIKE '%127.0.0.1:8017%'
      AND payload::text ILIKE '%ECONNREFUSED%'
  ) AS yua_max_v1_conn_refused_14d,
  ROUND(100.0 * COUNT(*) FILTER (WHERE latency_ms IS NOT NULL) / NULLIF(COUNT(*), 0), 2)
    AS latency_fill_rate_pct_14d,
  ROUND(100.0 * COUNT(*) FILTER (WHERE token_count IS NOT NULL) / NULLIF(COUNT(*), 0), 2)
    AS token_fill_rate_pct_14d,
  ROUND(100.0 * COUNT(*) FILTER (
    WHERE COALESCE(payload->>'content', payload->>'text', payload->>'answer', '') <> ''
  ) / NULLIF(COUNT(*) FILTER (WHERE event_kind = 'message'), 0), 2)
    AS message_response_fill_rate_pct_14d
FROM phase9_raw_event_log
WHERE occurred_at >= now() - interval '14 days';
