---
name: ci-check
description: Run the checks the PR workflow runs (ruff lint, pytest, databricks bundle validate) locally and summarise failures. Use before opening a PR or when asked whether the branch is green.
argument-hint: "[target: personal | free | aws]"
---

# CI check

Bundle target: $ARGUMENTS (use `personal` if empty).

These mirror `.github/workflows/ci.yml` as specified in `docs/plan/03_M2_foundation.md`. Run them in order
and keep going after a failure so the summary covers everything:

1. `uv run ruff check .`
2. `uv run pytest -q`
3. `databricks bundle validate -t <target>`. If it fails with an authentication or profile error, report
   that the `frostsight-<target>` CLI profile is not set up (`docs/plan/01_M0_accounts_and_sources.md`)
   instead of treating it as a code failure.

Also run `uv run ruff format --check .` and report it separately as advisory; CI does not enforce it.

Report one line per step: pass or fail, and for a failure the first error with its file and line.
Do not fix anything unless asked; if asked, `uv run ruff check --fix .` and `uv run ruff format .` are the
safe automatic fixes.
