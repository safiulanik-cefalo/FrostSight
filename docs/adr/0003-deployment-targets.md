# ADR-0003: Deployment targets, Free Edition and AWS

- Status: Proposed
- Date: 2026-09-29
- Owner: Safiul Anik

## Context

Databricks Free Edition costs nothing but limits the account to one active pipeline, five concurrent job
tasks, one 2X-Small SQL warehouse, restricted outbound internet and no service principals. A paid
serverless workspace on AWS removes those limits at an estimated $250 to $890 for the MVP build.
Details and cost model: `docs/platform-targets.md`.

## Options considered

1. Everything on Free Edition.
2. Free Edition, plus a paid AWS workspace for the build milestones M4 to M7.
3. Everything on a paid AWS workspace.

## Decision

Option 1 as the base, with an AWS serverless workspace as a second target from M4, starting on the 14-day
trial. One Asset Bundle with three targets: `free` (team workspace), `personal` (each engineer's own
Free Edition workspace) and `aws`. The code is identical on every target; only bundle variables differ.
Move to paid AWS usage only if the M2 gate shows the Free Edition limits are costing real time.

## Consequences

- Serverless everywhere. No cluster configuration anywhere in the repo.
- Nothing target-specific in Python or SQL. Target values live in `databricks.yml` variables.
- CI deploys as a user on Free Edition and as a service principal on AWS.
- Catalog, schemas, volume and grants are created by `sql/001_catalog_schemas_volume.sql` on each
  workspace, not by the bundle, so `mode: development` naming never touches them.
- Free Edition terms are non-commercial. Commercial use of FrostSight requires the AWS target.
