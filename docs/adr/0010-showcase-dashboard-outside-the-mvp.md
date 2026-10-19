# ADR-0010: Showcase dashboard outside the MVP

- Status: Proposed
- Date: 2026-10-12
- Owner: Safiul Anik

## Context

On 2026-10-05 the MVP kept the four AI/BI dashboards on Free Edition and shelved a custom frontend
(`docs/plan/07_M6_product.md`). We still want a page that shows FrostSight to people outside the team the way
a product demo does: a 3D view of a real Troms road with its risk, weather and closures, which AI/BI cannot
draw. It should cost nothing to run, need no Databricks login to view, and never disagree with the AI/BI
risk map. Design: `docs/superpowers/specs/2026-10-12-showcase-dashboard-design.md`.

## Options considered

1. AI/BI only. No extra work; no 3D view, and viewers need a workspace login.
2. A Databricks App. Reads gold directly, but on Free Edition apps stop after 24 h, need a login and use one
   of three app slots that S2 plans for the API.
3. A standalone web page on Cloudflare, reading gold through a Worker that holds the only credential.

## Decision

Option 3, as a demo built in parallel with the MVP and kept out of its milestones and the Asset Bundle. The
code lives in `showcase/`. A Worker cron reads the plot-ready gold tables (ADR-0009) through the SQL
Statement Execution API and stores one state document; the page reads only that document, or a committed
snapshot. Scripted scenarios play over the snapshot and everything they show is labelled "Simulated".

## Consequences

- Design rule 2 ("only `collector/` calls external URLs") governs pipelines and jobs. The showcase is a
  consumer outside the platform, like a browser: its bake script fetches public reference data once by
  hand, and its Worker reads gold through the warehouse as the AI/BI dashboards do.
- On Free Edition the Worker uses a personal access token of the deploying user, stored only as a Worker
  secret and in a gitignored `.dev.vars`. On the paid workspace it becomes a service principal with the
  read grants from `sql/001_catalog_schemas_volume.sql`.
- No pipeline, job or grant changes. `databricks.yml` excludes `showcase/**` from sync. Amended 2026-10-12:
  the incident list and map need each incident's own position, so `gold.incident_list` was added to
  `src/frostsight/serving.py`, as the last consequence below prescribes.
- The showcase does not replace the AI/BI dashboards. Road colours follow the same 5 km coverage rule as
  `gold.map_points`, so the two agree. Amended 2026-10-14: the page opens on a 2D map, with the 3D view a
  toggle away. The 2D map reads `gold.map_points` as it is (risk layers only) through the Worker and loads
  Kartverket's base map tiles in the browser; its search also finds towns through Kartverket's place-name
  API, called from the browser. No gold or silver change.
- Cars on the page are ambience, not traffic data, and the page says so.
- Joins in the Worker are lookups between small serving tables for one consumer. If the showcase needs
  more, the fix is a new plot-ready gold table, not more logic in the Worker.
- Architecture and design record: `docs/showcase/architecture.md`.
