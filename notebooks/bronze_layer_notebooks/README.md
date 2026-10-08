# Bronze ingestion notebooks

One production-grade Databricks notebook per external source in `docs/plan/`, covering every row of
the source table in `docs/plan/00_README.md` section 5 and `config/sources.yml`. Each notebook:

- Runs **serverless** — no cluster config, no RDD API (`sc.parallelize`, `.rdd.map`); the one place
  that needs to merge many landed JSON documents (`13`, `14`) does it by `.collect()`-ing strings to
  the driver and parsing with plain `json.loads`, not Spark's RDD-based JSON reader.
- Calls its source with a retry-and-backoff HTTP session (429/5xx get retried with backoff, same
  convention as `collector/ingest_bronze.py`'s `http()` helper).
- Writes the **raw, unparsed response body** (`raw_json_payload` or `raw_xml_payload`) plus an
  `ingestion_timestamp` (`current_timestamp()`) to `frostsight.bronze.<source>_bronze`, appending
  (`mode("append")`) so every run adds to history rather than overwriting it. No field extraction
  happens here — see `notebooks/silver_layer_transformation/` for that, which reads these exact
  tables and exact column names (`raw_json_payload`/`raw_xml_payload`, `ingestion_timestamp`).
- Takes its catalog, county and (where needed) secret scope as notebook widgets rather than
  hardcoded constants, so the same notebook runs unchanged against `personal`, `free` or `aws`.
- Skips its own run (via `dbutils.notebook.exit(...)`, not a failure) when a required secret
  (`frost_client_id`) is not yet in the secret scope — matching `docs/plan/01_M0_accounts_and_sources.md`
  T0.4's gate: credentials may legitimately not exist yet. DATEX needs no secret (ADR-0008: open WFS).

Secrets are read from `dbutils.secrets.get("frostsight", <key>)` — the scope created in
`docs/plan/01_M0_accounts_and_sources.md` T0.4 — never hardcoded.

| Notebook | Source | Endpoint | Notes |
|---|---|---|---|
| `01_nvdb_weather_station_location.py` | NVDB v4 | `vegobjekter/153` | Full county extract, paginated |
| `02_nvdb_traffic_station_location.py` | NVDB v4 | `vegobjekter/482` | Not in the MVP extract, landed anyway |
| `03_nvdb_speed_limit.py` | NVDB v4 | `vegobjekter/105` | Full county extract, paginated |
| `04_nvdb_accident.py` | NVDB v4 | `vegobjekter/570` | Date-filtered from `date_from` (5055 Ulykkesdato) |
| `05_nvdb_avalanche_landslide.py` | NVDB v4 | `vegobjekter/445` | Not date-filtered, on purpose |
| `06_nvdb_road_network.py` | NVDB v4 | `vegnett/veglenkesekvenser/segmentert` | Many pages; 5-15 min |
| `07_nvdb_county.py` | NVDB v4 | `omrader/fylker` | Single call, no pagination |
| `08_datex_road_weather.py` | Statens vegvesen WFS | `WeatherSimple_v2` | No auth (ADR-0008), national scope |
| `09_datex_incidents.py` | Statens vegvesen WFS | `SituationSimple_v2` | No auth, filtered to the county bbox |
| `10_datex_site_table.py` | Statens vegvesen WFS | `WeatherSimple_v2` | Same layer as `08`; no separate site endpoint |
| `11_frost_station_source.py` | MET Frost | `sources/v0.jsonld` | Client-id auth; skips if no credentials |
| `12_frost_observation_history.py` | MET Frost | `observations/v0.jsonld` | One call per station per month in `[date_from, date_to)`; up to ~150 calls |
| `13_open_meteo_elevation.py` | Open-Meteo | `v1/elevation` | Reads station points from `nvdb_weather_station_location_bronze`; run `01` first |
| `14_met_locationforecast.py` | MET Norway | `locationforecast/2.0/compact` | Post-MVP; same station-point dependency as `13` |
| `15_trafikkdata.py` | Statens vegvesen | trafikkdata GraphQL | Post-MVP, cut from MVP |

`generate.py` produced these files from the endpoints, pagination and auth described in
`docs/plan/02_M1_history_and_reference_data.md` and `docs/plan/01_M0_accounts_and_sources.md`, and from
`collector/ingest_bronze.py`'s retry/secret conventions. Re-run it if an endpoint, parameter or auth
method changes; it overwrites all 15 files.

**Known naming mismatch worth resolving before these run anywhere shared:** `collector/ingest_bronze.py`
(merged separately) uses catalog `winterroad` and different per-source table names (e.g.
`nvdb_road_weather_stations`); these notebooks use the catalog/table names given in this task
(`frostsight`, `<source>_bronze`) and match `databricks.yml`'s `catalog: frostsight` default. The two
should not both be pointed at the same workspace without picking one naming scheme.
