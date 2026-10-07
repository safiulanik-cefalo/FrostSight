# ADR-0001: Product scope and first slice

- Status: Proposed
- Date: 2026-09-29
- Owner: Safiul Anik

## Context

Norwegian winter roads ice over, close and see accidents depending on surface temperature, precipitation,
wind, terrain and traffic together. Statens vegvesen and MET Norway publish these signals as open data,
but as separate feeds with no risk view per road segment. The sources were checked live on 28 Sep 2026
(`docs/source-verification.md`): NVDB, trafikkdata, MET Locationforecast and Open-Meteo answer without
registration; DATEX II and MET Frost need a free account.

## Options considered

1. National coverage with icing, closure and accident risk from the start.
2. One county, icing risk only, with explainable drivers; closure, accident, traffic and ML later.
3. A synthetic data generator instead of live sources.

## Decision

Option 2. The first slice is a deterministic icing-risk score per NVDB road segment for one pilot county
(ADR-0002), fed by the 10-minute DATEX II road-weather stream, DATEX II incidents and NVDB reference data,
and shown on four dashboards: risk map, road detail, gritting priority list and platform health.

## Consequences

- The MVP proves the full path (collector, medallion tables, risk engine, dashboards) on a small, real data set.
- Closure risk, accident risk, traffic, alerts, the API, storm replay and ML are staged as stretch work
  (`docs/plan/10_S1_replay.md` to `12_S3_ml.md`) and later scope.
- Without a Norwegian road-maintenance contact, risk weights are a documented heuristic, checked against
  historical incidents rather than expert judgement.
- FrostSight is not an official warning service; every output carries its timestamp and data freshness.
