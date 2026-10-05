---
paths:
  - "collector/**"
  - "config/sources.yml"
---

# Collector and source config

- The collector runs outside Databricks (ADR-0004). It never imports Spark.
- It is the only code that calls external URLs. Endpoints, headers, cadence and licence come from
  `config/sources.yml`, not from constants in code.
- Credentials are read from the environment variable or secret-scope key named in `secret:`. Never write a
  credential value into `config/` or a fixture, and never print one in logs.
- Landing paths follow `raw/<source>/<yyyy>/<mm>/<dd>/<UTC timestamp>.jsonl` with one flat folder per
  source. A failed run writes `raw/<source>/_failed/<UTC timestamp>.json` instead of a partial file.
- DATEX XML is converted to JSON lines and the raw XML is kept beside it in the `*_xml` source.
