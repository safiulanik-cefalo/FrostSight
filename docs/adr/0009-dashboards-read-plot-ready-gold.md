# ADR-0009: Dashboards read plot-ready gold tables

- Status: Proposed
- Date: 2026-10-09
- Owner: Safiul Anik

## Context

The first live dashboard (`docs/gold-from-team-silver.md`) read the core gold tables through `v_*` views with
the dataset SQL of the mock and of 07_M6 T6.4: joins, aggregation, window functions and a distance calculation
from every road point to every station, run on every dashboard load. Gold is fetched every 4 h during
development, so those results only change after a fetch, and logic that belongs to the data layer lived in
dashboard JSON where no test covers it. Gold exists so consumers read results, not compute them.

## Options considered

1. Dataset SQL joins core gold tables and views at read time (07_M6 T6.4 as written). Not chosen: recomputes on
   every load, splits logic between the job and the JSON, and the JSON SQL is untested.
2. One gold view per widget. Not chosen: the SQL moves out of the JSON, but still runs on every load.
3. One plot-ready table per widget group, built by the gold job after every fetch. Chosen.
4. Lakeflow materialized views for the same tables. Not now: gold is built by a job and Free Edition allows one
   pipeline; worth revisiting if gold moves into the pipeline. TBD.

## Decision

Option 3. `src/frostsight/serving.py` defines the plot-ready tables (`station_status`, `map_points`,
`segment_detail`, `segment_drivers`, `segment_risk_types`, `segment_history`, `segment_readings`,
`segment_incidents`, `priority_list`, `kpi_summary`); `build_gold` rebuilds them last in every run with
`CREATE OR REPLACE TABLE ... AS SELECT`, so readers see one fetch or the next, never a half-built table. Every
dashboard dataset is a select on one table. Only values relative to the viewer's clock stay in the query, as one
expression on that table: minutes ago, data age, whether an incident is still active, freshness delay and status.

## Consequences

- Dashboard SQL is short and fast; a load costs a scan of one small table.
- `tests/unit/test_serving.py` fails if a live dataset reads more than one table, or a plot-ready table reads one
  built after it. `.claude/rules/dashboards-and-gold.md` states the rule for agents.
- A new widget that needs new data changes `serving.py`, not the dashboard JSON.
- Gold holds about ten more tables than the spec's section 7.3 list. They are a serving layer, rebuilt from the
  core gold tables on every run, and can be dropped and rebuilt at any time.
- The dataset SQL in 07_M6 T6.4 and the `v_*` views of its step 2 are superseded for live dashboards. The mock
  dashboard keeps its read-time SQL, because `frostsight.mock` has no gold job.
- When the reference job (05_M4 T4.6) replaces the interim `silver.nvdb_seed_*` tables, only the inputs of
  `serving.py` change; the dashboard does not.
