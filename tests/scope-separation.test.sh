#!/bin/bash
# YUA / YUAN Scope Separation QA Test Suite
# 실행: bash tests/scope-separation.test.sh

BASE="http://localhost:4000/api"
YUA_KEY="yua-e4e0d2e2-5e03-4a8a-93ea-5936e8bd4ce2"  # scope=yua (마스터키)
YUAN_KEY=$(cat /tmp/yuan_test_key.txt 2>/dev/null)  # yuan scope 키

PASS=0
FAIL=0
SKIP=0

check() {
  local name="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✅ PASS: $name"
    ((PASS++))
  else
    echo "  ❌ FAIL: $name (expected: $expected, got: $actual)"
    ((FAIL++))
  fi
}

skip() {
  local name="$1" reason="$2"
  echo "  ⏭️  SKIP: $name ($reason)"
  ((SKIP++))
}

echo ""
echo "=========================================="
echo "  YUA / YUAN Scope Separation QA"
echo "=========================================="
echo ""

# ──────────────────────────────────────────
echo "▶ Group 1: YUA key → YUA endpoints (허용)"
# ──────────────────────────────────────────

R=$(curl -s -w "\n%{http_code}" "$BASE/v1/chat/completions" \
  -H "x-api-key: $YUA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"qa-scope-test"}],"model":"gpt-4.1-mini","stream":false}')
CODE=$(echo "$R" | tail -1)
check "YUA key → /v1/chat/completions = 200" "200" "$CODE"

# ──────────────────────────────────────────
echo ""
echo "▶ Group 2: YUA key → YUAN endpoints (차단)"
# ──────────────────────────────────────────

R=$(curl -s "$BASE/yuan-agent/sessions" -H "x-api-key: $YUA_KEY")
check "YUA key → /yuan-agent/sessions = scope_mismatch" "scope_mismatch" "$R"

R=$(curl -s "$BASE/yuan-agent/run" \
  -H "x-api-key: $YUA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"hello"}')
check "YUA key → /yuan-agent/run = scope_mismatch" "scope_mismatch" "$R"

R=$(curl -s "$BASE/yuan-agent/stop" \
  -H "x-api-key: $YUA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"fake"}')
check "YUA key → /yuan-agent/stop = scope_mismatch" "scope_mismatch" "$R"

R=$(curl -s "$BASE/yuan-agent/stream?sessionId=fake" -H "x-api-key: $YUA_KEY")
check "YUA key → /yuan-agent/stream = scope_mismatch" "scope_mismatch" "$R"

R=$(curl -s "$BASE/yuan-agent/approve" \
  -H "x-api-key: $YUA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"fake","actionId":"fake","response":"approve"}')
check "YUA key → /yuan-agent/approve = scope_mismatch" "scope_mismatch" "$R"

R=$(curl -s "$BASE/yuan-agent/interrupt" \
  -H "x-api-key: $YUA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"fake","type":"soft"}')
check "YUA key → /yuan-agent/interrupt = scope_mismatch" "scope_mismatch" "$R"

R=$(curl -s "$BASE/yuan-agent/status?sessionId=fake" -H "x-api-key: $YUA_KEY")
check "YUA key → /yuan-agent/status = scope_mismatch" "scope_mismatch" "$R"

# ──────────────────────────────────────────
echo ""
echo "▶ Group 3: YUAN key → YUA endpoints (차단)"
# ──────────────────────────────────────────

if [ -z "$YUAN_KEY" ]; then
  skip "YUAN key → /v1/chat/completions = scope_mismatch" "yuan scope 키 미생성"
  skip "YUAN key → /yuan-agent/sessions = 200" "yuan scope 키 미생성"
  skip "YUAN key → /yuan-agent/run = 200 (session created)" "yuan scope 키 미생성"
else
  R=$(curl -s -w "\n%{http_code}" "$BASE/v1/chat/completions" \
    -H "x-api-key: $YUAN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"should block"}],"model":"gpt-4.1-mini","stream":false}')
  check "YUAN key → /v1/chat/completions = scope_mismatch" "scope_mismatch" "$R"

  R=$(curl -s -w "\n%{http_code}" "$BASE/yuan-agent/sessions" -H "x-api-key: $YUAN_KEY")
  CODE=$(echo "$R" | tail -1)
  check "YUAN key → /yuan-agent/sessions = 200" "200" "$CODE"

  R=$(curl -s "$BASE/yuan-agent/run" \
    -H "x-api-key: $YUAN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"prompt":"test agent run","workDir":"/tmp/yuan-agent/test"}')
  check "YUAN key → /yuan-agent/run = ok" "\"ok\":true" "$R"
fi

# ──────────────────────────────────────────
echo ""
echo "▶ Group 4: 인증 없음 (전부 401)"
# ──────────────────────────────────────────

R=$(curl -s "$BASE/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"no auth"}],"model":"gpt-4.1-mini"}')
check "No auth → /v1/chat/completions = authorization_required" "authorization_required" "$R"

R=$(curl -s "$BASE/yuan-agent/sessions")
check "No auth → /yuan-agent/sessions = authorization_required" "authorization_required" "$R"

R=$(curl -s "$BASE/yuan-agent/run" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"no auth"}')
check "No auth → /yuan-agent/run = authorization_required" "authorization_required" "$R"

# ──────────────────────────────────────────
echo ""
echo "▶ Group 5: 잘못된 키 (401)"
# ──────────────────────────────────────────

R=$(curl -s "$BASE/v1/chat/completions" \
  -H "x-api-key: fake-invalid-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"bad key"}],"model":"gpt-4.1-mini"}')
check "Invalid key → /v1/chat/completions = invalid_api_key" "invalid_api_key" "$R"

R=$(curl -s "$BASE/yuan-agent/sessions" -H "x-api-key: fake-invalid-key-12345")
check "Invalid key → /yuan-agent/sessions = invalid_api_key" "invalid_api_key" "$R"

# ──────────────────────────────────────────
echo ""
echo "▶ Group 6: 홈페이지 + 헬스체크"
# ──────────────────────────────────────────

R=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/)
check "Homepage (yua-web) = 200" "200" "$R"

R=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/api/health)
check "Backend /health = 200" "200" "$R"

# ──────────────────────────────────────────
echo ""
echo "=========================================="
echo "  Results: ✅ $PASS passed / ❌ $FAIL failed / ⏭️ $SKIP skipped"
echo "=========================================="

# 테스트 데이터 정리
echo ""
echo "🧹 Cleaning up test threads..."
PGPASSWORD='djaeorms12@@' psql -h 127.0.0.1 -U yua -d yua_ai -t -c \
  "SELECT id FROM conversation_threads WHERE user_id = 8 AND title LIKE '%qa-scope-test%' OR title LIKE '[API] qa-scope%';" 2>/dev/null | while read -r tid; do
  tid=$(echo "$tid" | tr -d ' ')
  if [ -n "$tid" ]; then
    PGPASSWORD='djaeorms12@@' psql -h 127.0.0.1 -U yua -d yua_ai -c \
      "DELETE FROM chat_messages WHERE thread_id = $tid; DELETE FROM conversation_threads WHERE id = $tid;" 2>/dev/null
    echo "   Deleted thread $tid"
  fi
done
echo "🧹 Done."

exit $FAIL
