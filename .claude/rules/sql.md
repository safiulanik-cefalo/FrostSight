---
paths:
  - "sql/**/*.sql"
---

# Workspace setup SQL

- Files in `sql/` run once per workspace in the SQL editor and must stay idempotent: `CREATE ... IF NOT
  EXISTS`, grants that can be re-run.
- These files own the catalog, schemas, landing volume and grants (ADR-0003). Never move that into the bundle.
- Use three-level names (`frostsight.<schema>.<object>`). Schemas are `landing`, `bronze`, `silver`, `gold`,
  `quarantine`, `ml`.
- Do not add `DROP` or `TRUNCATE` statements here; destructive changes need their own reviewed migration.
