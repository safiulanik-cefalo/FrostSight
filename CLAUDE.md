# FrostSight

Winter road icing risk per NVDB road segment, pilot county Troms (`fylke=55`). Runs on Databricks:
an external collector lands files in a Unity Catalog volume, one Lakeflow Declarative Pipeline builds
bronze and silver, a scheduled job writes gold, AI/BI dashboards read gold.

## Commands

```bash
uv sync                                   # install, Python 3.12
uv run pytest                             # unit tests (tests/unit, local PySpark)
uv run ruff check . && uv run ruff format --check .
databricks bundle validate -t personal    # targets: personal (default), free, aws
databricks bundle deploy -t personal      # never deploy free or aws without being asked
```

CLI profiles are `frostsight-personal`, `frostsight-free`, `frostsight-aws` (see `databricks.yml`).

## Where things are

- `docs/plan/00_README.md` holds the conventions every milestone relies on: layout (section 3), naming
  (section 4) and the bundle variable table (section 2). Read it before adding a new module or table.
- Milestone files `docs/plan/01_*` to `13_*` are long (500 to 1500 lines). Read only the milestone and
  task (`T<m>.<n>`) you are working on, not the whole folder.
- Architecture decisions are in `docs/adr/`; new ones use `docs/adr/0000-template.md` (`/new-adr`).
- Data sources, endpoints, auth and licences are in `config/sources.yml`, verified in
  `docs/source-verification.md`.

## Design rules (from docs/plan/00_README.md section 2)

1. Never configure a cluster. Every job task and pipeline is serverless.
2. Only `collector/` calls external URLs. Pipelines and jobs read only the landing volume and Unity Catalog.
3. Target-specific values are bundle variables. Nothing target-specific is hard-coded in Python or SQL.
4. Catalog, schemas, the landing volume and grants come from `sql/001_catalog_schemas_volume.sql`,
   never from the bundle. The bundle owns only the pipeline, jobs and dashboards.
5. Schema and table names are identical on every target.

## Conventions

- Python: `snake_case`, type hints, one function per transform, no Spark session created inside a function.
  Pure logic goes in `src/frostsight/` and gets a unit test in `tests/unit/`.
- Timestamps are UTC; `event_time` is measurement time, `_ingested_at` is arrival. Units: °C, m/s, mm, metres.
- Risk levels are `LOW`, `MEDIUM`, `HIGH`, `VERY_HIGH`.
- Dashboards read plot-ready gold tables: every dataset is a select on one table, no read-time joins or
  aggregation (ADR-0009, `.claude/rules/dashboards-and-gold.md`). The mock's SQL is not a pattern for live data.
- Secrets never go in the repo or `config/*.yml`; `secret:` in `config/sources.yml` names the environment
  variable or secret-scope key to read.
- Branches `feature/<milestone>-<short-name>`, PR into `main`, squash merge. Owners are in `.github/CODEOWNERS`.
- Attribution: Statens vegvesen data is NLOD, MET Norway and Open-Meteo data is CC BY 4.0.
