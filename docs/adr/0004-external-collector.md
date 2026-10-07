# ADR-0004: External collector

- Status: Proposed. Host choice and DATEX format amended by ADR-0008
- Date: 2026-09-29
- Owner: Safiul Anik

## Context

On Free Edition, notebooks and jobs cannot call the source APIs because outbound internet is restricted.
The DATEX II access form asks for a fixed IP address or DNS name, which GitHub Actions and serverless
compute do not have.

## Options considered

1. GitHub Actions cron. No fixed IP, 2,000 free minutes per month on a private repository.
2. A small host with a static IP (a Cefalo server or a $5 VM) running a systemd timer.
3. The collector as a job task inside an AWS workspace, which has open outbound access.

## Decision

The collector is a plain Python package, `collector/`, that never imports Spark. It runs on a schedule
outside Databricks and writes files into the landing volume through the Databricks Files API. The host is
chosen at M2 from Statens vegvesen's answer on whether the fixed IP is enforced: GitHub Actions if it is
not, a static-IP host if it is. On the `aws` target the same package may also run as a job task.

## Consequences

- Ingestion is file-based Auto Loader from the landing volume on every target.
- Landing file names are the idempotency key: `raw/<source>/<yyyy>/<mm>/<dd>/<UTC timestamp>.jsonl`.
- The collector flattens DATEX XML to JSON lines and keeps the raw XML beside it.
- Collection cadence is bounded by the scheduler: every 30 minutes on GitHub Actions within the free
  minutes, every 10 minutes on a static-IP host or an AWS job.

ADR-0008 moves road weather and incidents to the open WFS: no account, no fixed IP, GeoJSON instead of
XML. The collector stays external; the host no longer depends on the fixed-IP answer.
