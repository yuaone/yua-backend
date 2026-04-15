-- ============================================================
-- YUAN Plugin Marketplace Tables
-- Database: yua_ai (PostgreSQL)
-- Created: 2026-03-10
--
-- 5 tables: plugin_registry, plugin_versions, user_plugins,
--           skill_executions, plugin_reviews
-- ============================================================

BEGIN;

-- ============================================================
-- 1. plugin_registry — Published plugins in the marketplace
-- ============================================================

CREATE TABLE IF NOT EXISTS plugin_registry (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL UNIQUE,
    display_name    VARCHAR(200),
    description     TEXT,
    author          VARCHAR(200) NOT NULL,
    author_id       INTEGER,
    category        VARCHAR(50) NOT NULL DEFAULT 'general'
                    CHECK (category IN ('general','language','framework','security','testing','devops','database')),
    trust_level     VARCHAR(20) NOT NULL DEFAULT 'community'
                    CHECK (trust_level IN ('official','verified','community')),
    latest_version  VARCHAR(20) NOT NULL,
    total_downloads INTEGER DEFAULT 0,
    total_reviews   INTEGER DEFAULT 0,
    avg_rating      NUMERIC(3,2) DEFAULT 0,
    homepage_url    VARCHAR(500),
    repository_url  VARCHAR(500),
    npm_package     VARCHAR(200),
    tags            JSONB DEFAULT '[]',
    is_deprecated   BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugin_registry_name
    ON plugin_registry (name);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_category
    ON plugin_registry (category);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_trust
    ON plugin_registry (trust_level);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_downloads
    ON plugin_registry (total_downloads DESC);

-- ============================================================
-- 2. plugin_versions — Version history for each plugin
-- ============================================================

CREATE TABLE IF NOT EXISTS plugin_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id       UUID NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
    version         VARCHAR(20) NOT NULL,
    changelog       TEXT,
    manifest        JSONB NOT NULL,
    min_yuan_version VARCHAR(20),
    file_size       INTEGER,
    checksum        VARCHAR(64),
    published_by    INTEGER,
    is_yanked       BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (plugin_id, version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin
    ON plugin_versions (plugin_id);

-- ============================================================
-- 3. user_plugins — Per-user installed plugins
-- ============================================================

CREATE TABLE IF NOT EXISTS user_plugins (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           INTEGER NOT NULL,
    workspace_id      UUID,
    plugin_name       VARCHAR(100) NOT NULL,
    installed_version VARCHAR(20) NOT NULL,
    is_enabled        BOOLEAN DEFAULT true,
    config            JSONB DEFAULT '{}',
    installed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (user_id, workspace_id, plugin_name)
);

CREATE INDEX IF NOT EXISTS idx_user_plugins_user
    ON user_plugins (user_id);

-- ============================================================
-- 4. skill_executions — Execution log for skill usage analytics
-- ============================================================

CREATE TABLE IF NOT EXISTS skill_executions (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    session_id      UUID,
    plugin_name     VARCHAR(100) NOT NULL,
    skill_id        VARCHAR(100) NOT NULL,
    trigger_type    VARCHAR(20) NOT NULL
                    CHECK (trigger_type IN ('manual','auto','error','file')),
    success         BOOLEAN NOT NULL,
    execution_ms    INTEGER,
    error_message   TEXT,
    context         JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_executions_user
    ON skill_executions (user_id);
CREATE INDEX IF NOT EXISTS idx_skill_executions_plugin_skill
    ON skill_executions (plugin_name, skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_executions_created
    ON skill_executions (created_at);

-- ============================================================
-- 5. plugin_reviews — User reviews/ratings for plugins
-- ============================================================

CREATE TABLE IF NOT EXISTS plugin_reviews (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id           UUID NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
    user_id             INTEGER NOT NULL,
    rating              INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title               VARCHAR(200),
    body                TEXT,
    is_verified_purchase BOOLEAN DEFAULT false,
    helpful_count       INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (plugin_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_reviews_plugin
    ON plugin_reviews (plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_reviews_rating
    ON plugin_reviews (rating);

-- ============================================================
-- Done
-- ============================================================

COMMIT;
