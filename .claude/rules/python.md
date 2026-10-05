---
paths:
  - "src/frostsight/**/*.py"
  - "collector/**/*.py"
  - "tests/**/*.py"
---

# Python code

- Target Python 3.12, line length 110, ruff rules `E F I B UP` (`pyproject.toml`). Run
  `uv run ruff check . && uv run ruff format .` before finishing.
- `src/frostsight/` holds pure functions: no I/O, no network, no `SparkSession.builder` inside a function.
  Take a DataFrame or plain values in, return a DataFrame or plain values out.
- Every new function in `src/frostsight/` gets a test in `tests/unit/`. Small real samples go in
  `tests/fixtures/`; never call a live API from a test.
- Runtime dependencies are only `pyyaml` and `requests`. Spark, delta and databricks-sdk are preinstalled on
  serverless; anything else is an extra or a dev dependency in `pyproject.toml`.
- Use UTC-aware datetimes. Keep units in °C, m/s, mm and metres.
