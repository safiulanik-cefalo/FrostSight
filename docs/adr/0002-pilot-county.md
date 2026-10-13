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

## Amendment, 2026-10-13: three more counties for variety

Troms stays the pilot: its scoring, thresholds and AI/BI defaults are unchanged. To show the product on
different roads and climates, the monitored area also takes Oslo (`fylke=3`, 3 road-weather stations),
Akershus (`32`, 30) and Innlandet (`34`, 58), 115 stations in all.

- The NVDB reference seed (`tools/mock_dashboards/fetch_nvdb.py`, loaded into `silver.nvdb_seed_*`) lists
  the counties and gives every row a `county` column (the DATEX county name). Gold reads the counties from
  the seed, so the seed alone decides the monitored area; `build_gold` has no county constant.
- DATEX road weather was already national. Incidents are fetched per county bbox and merged into one bronze
  row (`notebooks/bronze_layer_notebooks/09_datex_incidents.py`, widget `county` = `55,3,32,34`).
- Gold serving tables the showcase splits by area carry `county`; `priority_list` ranks within a county.
  `kpi_summary` stays one row for all counties.
- The showcase shows three overview regions: Troms, Oslo and Akershus together (Oslo lies inside Akershus
  and has three stations), and Innlandet.
- The mock dashboard and its mock incidents stay on Troms.
