# ADR-0002: Pilot county

- Status: Proposed
- Date: 2026-09-29
- Owner: Safiul Anik (decision), Saiful Islam Rayhan (figures, plan task T0.6)

## Context

One county keeps the NVDB extract, the station-to-segment lookup and the SQL warehouse load small. NVDB
statistics observed on 28 Sep 2026:

| Metric | Troms (55) | Innlandet (34) |
|---|---|---|
| Road-weather stations (object type 153) | 30 | 61 |
| Accidents (570), all years | 8,248 | 25,566 |
| Accidents (570), 2021 onwards | 483 | 1,723 |
| Avalanche and landslide events (445) | 5,470 | 671 |
| Traffic registration stations (482) | 147 | not checked |
| Exposure | coast, fjords, mountain passes | inland, less wind |

## Options considered

1. Troms (`fylke=55`).
2. Innlandet (`fylke=34`).

## Decision

Troms. It has eight times more slide events, coastal wind and frequent freeze-thaw cycles, which is the
icing signal the first slice scores, and a station count that keeps the lookup and the map fast on the
smallest serverless warehouse.

## Consequences

- `fylke=55` in every NVDB call; bundle variable `pilot_county` defaults to `"55"`.
- Frost sources are filtered to the county. DATEX snapshots are national and are filtered to the county's
  station ids in silver.
- The ML stretch has fewer labels. If it needs more, the collector takes `--county 34` and the extract is
  rerun; nothing else changes.
