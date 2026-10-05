---
paths:
  - "**/*.yml"
  - "src/**/*.py"
---

# Bundle, pipeline and jobs

- The variable table in `docs/plan/00_README.md` section 2 is authoritative. Add a variable there and in
  `databricks.yml` together.
- Serverless only: never add `new_cluster`, `job_clusters` or `existing_cluster_id`.
- There is exactly one Lakeflow Declarative Pipeline (`ingest`). Free Edition allows one active pipeline and
  five concurrent tasks, so chain job tasks serially.
- Pipelines and jobs read only from the landing volume and Unity Catalog tables, never from a URL.
- Expectations route failing rows to `quarantine.*` tables rather than dropping them silently.
- Run `databricks bundle validate -t personal` after any change here.
