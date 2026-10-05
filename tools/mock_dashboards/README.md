# Mock dashboards

A preview of the M6 dashboards before M4 to M6 deliver real data. One AI/BI dashboard, four pages (Risk map,
Road detail, Gritting priority, Platform health), reading `frostsight.mock`. That schema has the same table
and view names as `gold` (07_M6 T6.4). The roads, the 24 road-weather stations and each station's nearest
segment are real NVDB data; the readings are a synthetic storm morning. The risk is the real v0 model, and every
timestamp is relative to now, so the dashboard always looks live.

| File | What |
|---|---|
| `fetch_nvdb.py` | Fetches the roads that have a station and the stations themselves from NVDB; writes `nvdb_seed.sql` and `nvdb_seed.json`. Run it again only to refresh them |
| `nvdb_seed.sql` | Generated: road lines and points every 300 m, stations, their nearest segment, mock incidents |
| `mock_data.sql` | Synthetic readings, the v0 risk, freshness and quality numbers, and the views the dashboard reads |
| `build_dashboard.py` | Writes `frostsight_demo.lvdash.json`; edit this, not the JSON |
| `deploy.py` | Loads the mock, tests every dataset, creates or updates the dashboard and publishes it |

## Run

```bash
databricks auth login --profile frostsight-personal     # once
uv run --with shapely python tools/mock_dashboards/fetch_nvdb.py   # optional: nvdb_seed.sql is committed
uv run python tools/mock_dashboards/build_dashboard.py
uv run python tools/mock_dashboards/deploy.py --setup   # --setup runs sql/001 first; needed once per workspace
```

`deploy.py` prints the draft and published links. Run it again after any change; it updates the same
dashboard. Remove everything with `DROP SCHEMA frostsight.mock CASCADE` and `databricks lakeview trash <id>`.

## Demo path (08_M7 T7.8, on mock data)

1. **Platform health.** Incidents are STALE (75 min against a 60 min threshold), and the delay line shows the
   collector outage about six hours ago. The point: freshness is visible, not hidden.
2. **Risk map.** Counters, then the map: the road network in grey with a risk marker at each station's
   segment. The E8 mountain stretch towards Finland and the inland E6 are red, the coast yellow. Gardeborri
   is stale in the station list (NVDB marks it temporarily out of service). The E8 closure at Bossovarri is in
   the incident table.
3. **Road detail**, `E8 · Bossovarri` (the default). The driver bars explain the level; the two 24-hour lines
   show the surface falling through 0 °C as the snow starts.
4. **Gritting priority.** Filter to E8 and E6, then drag the surface slider to 0 °C or below. Clicking a bar
   filters the list.

## Moving to gold

The JSON uses bare table names. At M6, deploy it with `dataset_schema: gold` (07_M6 T6.6), or copy the pages
into the four planned files. Things the mock adds on top of 07_M6 T6.4, still to fold into the plan:
a road-network layer under the risk markers (`v_road_points` from `silver.road_segments`; one NVDB segment is
often only metres long, so a single segment never reads as a road); a `road` label (`E8`, `Fv862`) in
`v_segments`; field-bound filters instead of parameters; and the four dashboards as pages of one dashboard.
