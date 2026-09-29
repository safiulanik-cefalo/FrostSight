-- 001_catalog_schemas_volume.sql
-- Run once per workspace (team and every personal one) in the SQL editor on a serverless warehouse.
-- Idempotent. The bundle never creates these objects (ADR-0003).

CREATE CATALOG IF NOT EXISTS frostsight COMMENT 'FrostSight';
USE CATALOG frostsight;

CREATE SCHEMA IF NOT EXISTS landing    COMMENT 'Raw files from the collector and the replay harness';
CREATE SCHEMA IF NOT EXISTS bronze     COMMENT 'Source records as received, plus ingestion metadata';
CREATE SCHEMA IF NOT EXISTS silver     COMMENT 'Normalised, validated, deduplicated, mapped to segments';
CREATE SCHEMA IF NOT EXISTS gold       COMMENT 'Risk, summaries, freshness; what dashboards read';
CREATE SCHEMA IF NOT EXISTS quarantine COMMENT 'Rows that failed a rule, with the rule and reason';
CREATE SCHEMA IF NOT EXISTS ml         COMMENT 'Features, labels and registered models';

-- Managed volume. Path: /Volumes/frostsight/landing/raw/<source>/<yyyy>/<mm>/<dd>/<UTC timestamp>.jsonl
CREATE VOLUME IF NOT EXISTS landing.raw COMMENT 'Landing zone for collector and replay files';

-- Read access for every workspace user. Unity Catalog grants take account-level principals.
GRANT USE CATALOG ON CATALOG frostsight TO `account users`;
GRANT USE SCHEMA, SELECT ON SCHEMA frostsight.gold   TO `account users`;
GRANT USE SCHEMA, SELECT ON SCHEMA frostsight.silver TO `account users`;

-- Team workspace only: write access per engineer. Repeat the block for each sign-in identity.
-- GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.landing    TO `<engineer-email>`;
-- GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.bronze     TO `<engineer-email>`;
-- GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.silver     TO `<engineer-email>`;
-- GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.gold       TO `<engineer-email>`;
-- GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.quarantine TO `<engineer-email>`;
-- GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.ml         TO `<engineer-email>`;
-- GRANT READ VOLUME, WRITE VOLUME ON VOLUME frostsight.landing.raw TO `<engineer-email>`;

SHOW GRANTS ON SCHEMA frostsight.silver;
SHOW GRANTS ON VOLUME frostsight.landing.raw;
