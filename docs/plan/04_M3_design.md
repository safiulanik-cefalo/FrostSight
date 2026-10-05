# M3: Design reviewed

Owners: Sani (silver schemas, streaming semantics), Rayhan (station-to-segment mapping benchmark), Safiul
(risk model v0, gold contracts, dashboard wireframes, review session). Read `00_README.md` and
`03_M2_foundation.md` first. M3 is a design milestone: little compute, several decisions, one review.

Goal: the silver schemas, the streaming semantics, the station-to-segment mapping method, the risk model v0
and the dashboard wireframes are decided, benchmarked where needed, and reviewed in one session. After M3,
M4 to M6 build without re-opening these questions. The column names below are the ones the M4 and M5 code
uses (`05_M4`, `06_M5`); if a name has to change, change it in all three files in one pull request.

Where things go: schemas and contracts in `docs/contracts.md` (this file's tables copied there),
decisions in the repo-root `docs/adr/0005-risk-model-v0.md`, `0006-station-segment-mapping.md`,
`0007-streaming-semantics.md`, benchmark SQL in `sql/benchmarks/`.

---

### T3.1 Silver schema definitions      owner: Sani
Why: every M4 table, expectation, test and gold query is written against these columns. Agree them once.

Do: copy the tables below into `docs/contracts.md`. Pipeline tables get their columns from the
`select` in `src/pipelines/silver.py` (05_M4 T4.4); job-written tables get a `CREATE TABLE IF NOT EXISTS`
or a first `saveAsTable` in `load_reference.py` (05_M4 T4.6).

Common metadata on every bronze and silver row (README section 4): `_ingested_at TIMESTAMP`, `_source STRING`,
`_source_file STRING`, `_source_event_id STRING`, `_batch_id STRING` (timestamp stem of the landing file, or
`replay:<event_id>`), `_schema_version STRING`.

`silver.road_weather_observations`: streaming table. Key `(station_id, event_time)`. Source: contract v1
lines in `raw/road_weather/` (02_M1 T1.5) through `bronze.road_weather_events`.

| Column | Type | Notes |
|---|---|---|
| station_id | STRING | contract `station_ref` = NVDB `Målestasjonsnummer`; null rows fail `station_known` and go to quarantine |
| event_time | TIMESTAMP | contract `measurement_time`, converted to UTC |
| air_temperature_c | DOUBLE | `transforms.to_celsius` |
| road_surface_temperature_c | DOUBLE | |
| dew_point_c | DOUBLE | |
| humidity_pct | DOUBLE | 0 to 100 |
| precipitation_type | STRING | upper case: `NONE`, `RAIN`, `DRIZZLE`, `SLEET`, `SNOW`, `FREEZING_RAIN`, `UNKNOWN` (`transforms.normalise_precip_type`) |
| precipitation_intensity_mm_h | DOUBLE | `mm/10min` from Frost replay files is multiplied by 6 |
| wind_speed_ms | DOUBLE | |
| wind_direction_deg | DOUBLE | 0 to 360 |
| road_surface_state | STRING | source vocabulary, upper-cased (`DRY`, `WET`, `ICE`, `SNOW`, `FROST`, ...), nullable |
| source_station_ref | STRING | contract `site_id`: the DATEX site id or the Frost source id |
| + metadata | | |

There is no `road_segment_id` on observations: the segment comes from `silver.station_segment_lookup` at
query time (gold joins on `station_id`, 06_M5 T5.4). One join in one place, and the lookup can be
recomputed without touching a streaming table.

`silver.road_incidents`: **materialized view** (05_M4 section 1), one current row per incident. Key
`incident_id`. The DATEX situation feed is a snapshot that repeats every open incident with a new version;
"latest version per id" and "nearest segment on the same road" are `GROUP BY` / `min_by` shapes that an
append-only streaming table cannot express, so the view recomputes them on each update.

| Column | Type | Notes |
|---|---|---|
| incident_id | STRING | DATEX situation record id |
| incident_type | STRING | `CLOSURE`, `ACCIDENT`, `ROADWORK`, `WEATHER`, `OBSTRUCTION`, `OTHER` |
| severity | STRING | `HIGH`, `MEDIUM`, `LOW`, `UNKNOWN` |
| road_ref | STRING | e.g. `E8`, `FV862`, as the source sent it |
| road_segment_id | STRING | nullable; nearest segment within 500 m on the same road number (H3 cell join then `ST_Distance`); null rows are listed in `quarantine.unmapped_observations` |
| start_time | TIMESTAMP | |
| end_time | TIMESTAMP | null while open |
| description | STRING | |
| lat, lon | DOUBLE | WGS84 point (first point of the location) |
| + metadata | | `_source_event_id` = `incident_id:version` of the newest version |

`silver.road_segments`: written by the reference job (Delta table, `MERGE` on the key per NVDB extract).
Key `road_segment_id`.

| Column | Type | Notes |
|---|---|---|
| road_segment_id | STRING | `<veglenkesekvensid>-<veglenkenummer>-<segmentnummer>`, e.g. `1113653-1-9` |
| veglenkesekvensid | BIGINT | |
| segment_no | INT | `segmentnummer` |
| road_category | STRING | `E`, `R`, `F`, `K`, `P`, `S` |
| road_number | STRING | e.g. `8`; the display name is `concat(road_category, road_number)` |
| from_m, to_m | DOUBLE | metre values along the road system reference |
| length_m | DOUBLE | |
| geometry_wkt_25833 | STRING | original NVDB LINESTRING Z, EPSG:25833 |
| geometry_wkt_4326 | STRING | reprojected 2D LINESTRING, lon lat (`frostsight.geo`) |
| elevation_m | DOUBLE | mean Z of the geometry, else null |
| h3_cells | ARRAY<BIGINT> | H3 resolution 9 cells covering the WGS84 line (`h3_coverash3`, fallback sampled points) |
| speed_limit | INT | from object type 105, nullable |
| county | INT | NVDB `fylke` |

`silver.road_weather_stations`: written by the reference job. Key `station_id`.

| Column | Type | Notes |
|---|---|---|
| station_id | STRING | NVDB object 153 `Målestasjonsnummer` |
| name | STRING | |
| nvdb_object_id | BIGINT | |
| lon, lat | DOUBLE | WGS84 from the NVDB POINT |
| elevation_m | DOUBLE | Z coordinate when present |
| datex_site_id | STRING | from `datex_sites`, nearest point within 300 m, nullable |
| frost_source_id | STRING | `SN...` id from `frost_sources`, nearest point within 300 m, nullable |

`silver.station_segment_lookup`: materialized view in the pipeline (`lookup.py`), recomputed on each update
from the two tables above. Key `station_id`. Only stations with a segment within 500 m have a row; the
others appear in `quarantine.unmapped_observations` with the nearest distance as the reason.

| Column | Type | Notes |
|---|---|---|
| station_id | STRING | |
| road_segment_id | STRING | nearest segment |
| distance_m | DOUBLE | |
| method | STRING | `h3_kring2_st_distance_25833` (T3.3 decision) |
| computed_at | TIMESTAMP | |

Also written by the reference job, small and job-only: `silver.accidents` (`accident_id`, `accident_date`,
`severity`, `road_condition`, `weather_condition`, `wkt_25833`, `wkt_4326`), `silver.avalanche_landslide_events`
(`event_id`, `event_date`, `event_type`, `road_damage`, `wkt_25833`, `wkt_4326`), `silver.admin_boundaries`
(`county`, `county_name`). `silver.data_quality_events`: defined in `03_M2` T2.8; plain Delta table filled
by the freshness job from the pipeline event log.

Quarantine tables (`quarantine.invalid_road_weather`, `quarantine.invalid_incidents`, `quarantine.schema_errors`,
`quarantine.unmapped_observations`) share one shape: `original_row STRING` (JSON), `_source` (or `source`),
`_source_file`, `_batch_id`, `quarantined_at TIMESTAMP`, `rule STRING` (the `dq_rules.yml` name),
`reason STRING`, `pipeline_run_id STRING`. One row per failed rule.

Streaming table versus materialized view, in SDP terms:

| | Streaming table | Materialized view |
|---|---|---|
| Declared as | `@dp.table()` returning `spark.readStream...` | `@dp.materialized_view()` returning `spark.read...` |
| What it holds | Rows appended incrementally; each source row processed once; state and checkpoint managed by the pipeline | The result of a query, recomputed on each update (incrementally when the engine can, else fully) |
| Fits | Auto Loader ingestion, dedup, row-level cleaning | Joins, aggregates and "latest per key" over reference data or snapshots |
| Full refresh | Truncates and re-reads the source from the start | Recomputes |

Assignment: `road_weather_observations` is a streaming table; `road_incidents` and `station_segment_lookup`
are materialized views; `road_segments`, `road_weather_stations`, `accidents`, `avalanche_landslide_events`,
`admin_boundaries`, `data_quality_events` are ordinary Delta tables written by jobs, because their source
is a batch API extract, not a stream.

Expect: `contracts.md` reviewed in T3.6; one column list per table, no "TBD"; the names match
`05_M4` `silver.py`, `lookup.py`, `load_reference.py` and `06_M5` `build_gold.py` character for character.

If it fails: column disagreements usually come from DATEX field names. Keep the source name in bronze and
the contract name in silver; the mapping lives in `transforms.py`, unit-tested with a fixture from M0.

---

### T3.2 Streaming semantics      owner: Sani
Why: correctness (event time, watermark, dedup, checkpoint, recovery) and the replay test both depend
on choices made here. Record them in ADR 0007.

| # | Decision | Rationale |
|---|---|---|
| D1 | Event time is the source measurement time (`event_time`), never the file time or `_ingested_at` | Replay writes old files fast; results must depend only on event time so replay equals live |
| D2 | Watermark 30 minutes on `event_time` in the silver streaming table | Sources publish every 10 minutes; the collector may lag one or two polls; 30 minutes covers that without holding much state |
| D3 | Dedup key `(station_id, event_time)` with `dropDuplicatesWithinWatermark` | The DATEX snapshot repeats the last reading when a station is silent, and the collector re-pulls the same snapshot; the same measurement must land once |
| D4 | Late rows beyond the watermark are dropped by the stateful operator, silently and by design. No expectation can count them (expectations run after the operator). Bronze keeps every row, so the freshness job (M6) counts late rows in batch as bronze rows per `_source_file` minus silver rows, and reports them on the health page | In SDP a streaming table cannot branch on "was this row late"; counting from bronze is auditable and cheap. Rows inside the watermark but late for a closed gold window are included at the next gold run (D5) |
| D5 | Windows and trends are batch over silver in `build_gold.py`, not streaming aggregations | Late rows are then simply included at the next run; state size and Free Edition quotas stay small; the exam concept is still demonstrated with the dedup watermark and a notebook example |
| D6 | Triggered by the `orchestrate` job every 10 minutes on `free`; `continuous: ${var.pipeline_continuous}` may be true on `aws` for a test | Free Edition fair use; continuous costs per hour on AWS |
| D7 | Checkpoints and Auto Loader schema location are managed by the pipeline; nobody sets `checkpointLocation` | Managed pipelines own them under the pipeline storage; setting them by hand breaks full refresh |
| D8 | Full refresh (`databricks bundle run ingest -t free --full-refresh`) truncates bronze and silver streaming tables and re-reads every landing file. Allowed only after a schema or rule change, announced in the channel, never during a demo | Re-reading months of files takes minutes to hours and re-runs every expectation; gold `MERGE` is idempotent so it recovers |
| D9 | Replay rows carry `_batch_id = replay:<event_id>` (from the file name) and live rows the timestamp stem; both flow through silver and gold unchanged in the MVP. The M7 diff query separates them; excluding replay from live gold is an S1 item | Live and replay share tables; the tag keeps them tellable apart; a filter in gold would hide the demo storm |

Sketch for M4 (not the final code; rule names are the `dq_rules.yml` names from `03_M2` T2.7):

```python
from pyspark import pipelines as dp

from frostsight.config import rules_by_action

CATALOG = spark.conf.get("frostsight.catalog")
HARD = rules_by_action("road_weather_observations", "drop", spark.conf.get("frostsight.config_dir"))
SOFT = rules_by_action("road_weather_observations", "warn", spark.conf.get("frostsight.config_dir"))


@dp.table(name=f"{CATALOG}.silver.road_weather_observations")
@dp.expect_all_or_drop(HARD)      # e.g. air_temp_range, station_known
@dp.expect_all(SOFT)              # e.g. surface_temp_present
def road_weather_observations():
    return (spark.readStream.table(f"{CATALOG}.bronze.road_weather_events")
            .transform(normalise)                       # frostsight.transforms, imported through root_path: ../src
            .withWatermark("event_time", "30 minutes")
            .dropDuplicatesWithinWatermark(["station_id", "event_time"]))
```

Expect: ADR 0007 with the table above; a unit test at M4 for the transforms that feeds two identical readings
and one late reading and asserts the counts; the late-file test in `05_M4` T4.8 step 5 (harness `--latest
--shift -25` inside, `--shift -125` outside the watermark) confirms D4 on a personal workspace.

If it fails: `dropDuplicatesWithinWatermark` needs Spark 3.5 or later; serverless pipelines have it. If the
`CURRENT` channel complains, switch the pipeline to `channel: PREVIEW` and note it; the fallback with the
same result for our key (it contains the event-time column) is `dropDuplicates` after the same watermark.

---

### T3.3 Station-to-segment mapping benchmark      owner: Rayhan
Why: every observation is keyed to a road segment through this lookup. Two methods, one benchmark, one
choice, recorded in ADR 0006. Data: 30 stations (NVDB 153) and about 20,000 segments in Troms, read from
the landing files M1 put in the volume (silver does not exist before M4).

Do:
1. Both function families must exist on the serverless warehouse. `01_M0` T0.9 already ran the checks
   (`h3_longlatash3(18.96, 69.65, 9)` returns a BIGINT; `ST_Distance(ST_Point(0, 0, 25833), ST_Point(3, 4, 25833))`
   returns `5.0`; ST_ functions are Public Preview on DBR 17.1+). Re-run them in SQL Editor now, plus:

```sql
SELECT ST_AsText(ST_Transform(ST_Point(18.96, 69.65, 4326), 25833)) AS utm33;   -- expect POINT(~ 653000 ~ 7731000)
SELECT h3_coverash3('LINESTRING(18.9 69.6, 18.91 69.61)', 9) AS cells;         -- expect an array of a few BIGINTs
```

   If `ST_Transform` or `ST_Distance` is missing, ST functions are not enabled on this warehouse; use
   method A only and compute the metre distance with a pandas UDF from `frostsight.geo`
   (`05_M4` T4.5 step 3) inside the pipeline instead.

2. Prepare two benchmark tables from landing (`sql/benchmarks/00_prepare.sql`; drop them after the ADR):

```sql
CREATE OR REPLACE TABLE frostsight.silver.bench_stations AS
SELECT filter(egenskaper, e -> e.navn = 'Målestasjonsnummer')[0].verdi::string AS station_id,
       ST_X(ST_Transform(ST_GeomFromWKT(geometri.wkt, 25833), 4326)) AS lon,
       ST_Y(ST_Transform(ST_GeomFromWKT(geometri.wkt, 25833), 4326)) AS lat
FROM read_files('/Volumes/frostsight/landing/raw/nvdb_stations/', format => 'json')
WHERE geometri.wkt LIKE 'POINT%';

CREATE OR REPLACE TABLE frostsight.silver.bench_segments AS
SELECT concat_ws('-', veglenkesekvensid, veglenkenummer, segmentnummer) AS road_segment_id,
       geometri.wkt AS geometry_wkt_25833,
       h3_coverash3(ST_AsText(ST_Transform(ST_GeomFromWKT(geometri.wkt, 25833), 4326)), 9) AS h3_cells
FROM read_files('/Volumes/frostsight/landing/raw/nvdb_road_network/', format => 'json')
WHERE geometri.wkt IS NOT NULL;
```

   verify: `ST_GeomFromWKT` accepts `LINESTRING Z` (drop the Z with `ST_Force2D` if it exists, else strip
   it in Python with `frostsight.geo.wkt_25833_to_4326` and load the result as a table). verify:
   `h3_coverash3` accepts a LINESTRING (documented as "linear or areal"); if it is polygon-only, the
   fallback is the sampled-point UDF `frostsight.geo.line_cells` (05_M4 T4.6), and the benchmark loads its
   output.

3. Method A, H3 at resolution 9 (`sql/benchmarks/mapping_h3.sql`). Cells are about 174 m across; a
   two-ring around the station cell reaches about 500 m. This is exactly the join `lookup.py` runs at M4.

```sql
WITH station_ring AS (
  SELECT station_id, lon, lat, explode(h3_kring(h3_longlatash3(lon, lat, 9), 2)) AS cell
  FROM frostsight.silver.bench_stations
),
segment_cells AS (
  SELECT road_segment_id, geometry_wkt_25833, explode(h3_cells) AS cell
  FROM frostsight.silver.bench_segments
),
candidates AS (
  SELECT r.station_id, c.road_segment_id,
         ST_Distance(ST_Transform(ST_Point(r.lon, r.lat, 4326), 25833),
                     ST_GeomFromWKT(c.geometry_wkt_25833, 25833)) AS distance_m
  FROM station_ring r
  JOIN segment_cells c USING (cell)
)
SELECT station_id, road_segment_id, distance_m, 'h3_kring2_st_distance_25833' AS method
FROM candidates
QUALIFY row_number() OVER (PARTITION BY station_id ORDER BY distance_m) = 1;
```

4. Method B, ST nearest by brute force (`sql/benchmarks/mapping_st.sql`). 30 x 20,000 = 600,000 distance
   calls, small.

```sql
WITH stations AS (
  SELECT station_id, ST_Transform(ST_Point(lon, lat, 4326), 25833) AS pt
  FROM frostsight.silver.bench_stations
),
segments AS (
  SELECT road_segment_id, ST_GeomFromWKT(geometry_wkt_25833, 25833) AS line
  FROM frostsight.silver.bench_segments
)
SELECT s.station_id, g.road_segment_id, ST_Distance(s.pt, g.line) AS distance_m, 'st_nearest' AS method
FROM stations s CROSS JOIN segments g
QUALIFY row_number() OVER (PARTITION BY s.station_id ORDER BY ST_Distance(s.pt, g.line)) = 1;
```

5. Timing. Run each query three times from a notebook attached to serverless and take the median:

```python
import time

for name in ("h3", "st"):
    sql = open(f"sql/benchmarks/mapping_{name}.sql").read()
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        rows = spark.sql(sql).collect()
        times.append(time.perf_counter() - t0)
    print(name, len(rows), "rows", round(sorted(times)[1], 2), "s median")
```

   Also open the query profile in SQL Editor for each and note rows read and shuffle bytes.

6. Acceptance and comparison table for the ADR:

| Criterion | Method A, H3 | Method B, ST nearest |
|---|---|---|
| Every station within 500 m of its segment, else absent from the lookup and listed in `quarantine.unmapped_observations` | must hold | must hold |
| Same segment chosen by both for at least 28 of 30 stations | | |
| Median run time on Troms | | |
| Scales to all of Norway (350 stations x 1M segments) | join on cell, yes | 350M distances, no |
| Needs ST functions | yes, for the final distance (or the pandas UDF fallback) | yes |

   Recommendation to test against: A (H3 pre-filter, ST distance to pick) as the method for
   `silver.station_segment_lookup`, B as the correctness oracle in a unit test on the 30 stations. If the
   two disagree for a station, keep the smaller distance and look at the geometry by hand; a station on a
   bridge or a junction is the usual cause.

Expect: both queries return 30 rows; the H3 query runs in a few seconds, the brute-force one in under a
minute; at most 2 stations differ; every distance is under 500 m except stations that sit beside a
municipal road missing from the extract, which have no lookup row.

If it fails:
- `h3_kring` returns nothing usable: the cell was built from `(lat, lon)` in the wrong order; the function
  is `h3_longlatash3(lon, lat, res)`, longitude first.
- Distances in degrees instead of metres: a geometry was built without `25833`, or `ST_Transform` is missing.
- Zero candidates for a station: the 2-ring is too small for a station more than 500 m from any road; that
  is the unmapped case, not a bug.

---

### T3.4 Risk model v0      owner: Safiul
Why: the icing score is the product. It must be explainable, configurable and simple enough to validate
against last winter's incidents (WR-UC-21). This is a documented heuristic, not a validated model. Its
weights come from reasoning about road icing, not from data; stretch scope S3 tests them. Record in ADR 0005.
The file below and the three worked examples are the ones `06_M5` T5.1 and `tests/unit/test_risk.py`
use; this section is the design record, `06_M5` is the code.

Inputs per station and time, from the newest observation in `silver.road_weather_observations` joined to
`silver.station_segment_lookup`: `road_surface_temperature_c` (Ts), `air_temperature_c` (Ta), `dew_point_c`
(Td), `precipitation_type`, and `temperature_change_1h` (dTs: the surface reading now minus the reading 55
to 65 minutes earlier, computed by `frostsight.windows.with_trends`).

Each factor is a piecewise-linear score in [0, 1] defined by breakpoints `[x, score]`: linear between two
breakpoints, flat outside the first and last, `0` for a null input (`frostsight.risk.interp`).
Precipitation is a lookup on the type.

`config/risk_weights.yml` (authoritative copy in `06_M5` T5.1):

```yaml
version: v0
weights:                  # must sum to 1.0
  surface_temp: 0.35
  air_temp: 0.15
  dew_point_spread: 0.15
  precipitation: 0.20
  temp_trend_1h: 0.15
breakpoints:              # [x, score] pairs; linear between, flat outside; null input scores 0
  surface_temp:     [[-2.0, 1.0], [0.0, 0.5], [3.0, 0.0]]
  air_temp:         [[-2.0, 1.0], [0.0, 0.5], [4.0, 0.0]]
  dew_point_spread: [[0.5, 1.0], [3.0, 0.0]]          # air_temperature_c - dew_point_c
  temp_trend_1h:    [[-3.0, 1.0], [-1.0, 0.5], [0.0, 0.0]]   # surface change over the last hour, °C
precipitation_scores:
  FREEZING_RAIN: 1.0
  SNOW: 0.9
  SLEET: 0.8
  RAIN: 0.5
  DRIZZLE: 0.4
  UNKNOWN: 0.2
  NONE: 0.0
levels:                   # lower bound of each level; below MEDIUM is LOW
  MEDIUM: 0.25
  HIGH: 0.5
  VERY_HIGH: 0.75
drivers_top: 3
```

Reading the breakpoints: `surface_temp` is 1.0 at or below -2 °C, 0.5 at 0 °C, 0 at or above 3 °C, linear
in between. `dew_point_spread` is 1.0 when the air is within 0.5 °C of its dew point (saturation, frost
or fog forms) and 0 at a spread of 3 °C or more. `temp_trend_1h` is 1.0 when the surface fell 3 °C or
more in the last hour, 0.5 at -1 °C, 0 when steady or warming.

Definitions: `icing_score = sum(weight_f * score_f)`; `risk_score = icing_score` in the MVP (closure and
accident risk are cut, so the spec's `max()` collapses); `risk_level` from the lower bounds
(`LOW < 0.25 <= MEDIUM < 0.5 <= HIGH < 0.75 <= VERY_HIGH`); `risk_drivers` = the three factors with the
largest `weight_f * score_f`, ties broken by factor name, as `array<struct<factor string, contribution
double>>`. Missing inputs: a null factor scores 0 and still appears in the contributions with 0; a row
without a surface temperature is scored (surface 0) and counted by the `surface_temp_present` warning,
so the health page shows how many segments were scored on partial data.

Worked examples (`tests/unit/test_risk.py` in `06_M5` T5.6 asserts exactly these numbers, in Python and
in Spark):

| Example | Inputs (Ts, Ta, Td, precip, dTs) | Factor scores (surface, air, dew, precip, trend) | icing_score | Level | Drivers |
|---|---|---|---|---|---|
| A. Cold clear night | -4.0, -3.0, -3.4, NONE, -0.5 | 1.0, 1.0, 1.0, 0.0, 0.25 | 0.6875 | HIGH | surface_temp 0.35, air_temp 0.15, dew_point_spread 0.15 |
| B. Mild rain | 4.0, 5.0, 3.0, RAIN, +0.5 | 0.0, 0.0, 0.4, 0.5, 0.0 | 0.16 | LOW | precipitation 0.10, dew_point_spread 0.06, air_temp 0.0 |
| C. Snow near zero, falling | -1.0, 0.5, -0.5, SNOW, -1.5 | 0.75, 0.4375, 0.8, 0.9, 0.625 | 0.721875 | HIGH | surface_temp 0.2625, precipitation 0.18, dew_point_spread 0.12 |

The arithmetic, so a reviewer can reproduce each row by hand:

- A. Ts -4 is at or below -2: surface 1.0. Ta -3 is at or below -2: air 1.0. Spread = -3 - (-3.4) = 0.4,
  at or below 0.5: dew 1.0. NONE: precip 0. dTs -0.5 lies between -1 (0.5) and 0 (0.0):
  0.5 + (0.0 - 0.5) x (-0.5 - (-1)) / 1 = 0.25.
  Score = 0.35 x 1.0 + 0.15 x 1.0 + 0.15 x 1.0 + 0.20 x 0 + 0.15 x 0.25 = 0.35 + 0.15 + 0.15 + 0 + 0.0375 =
  0.6875, HIGH (0.5 <= 0.6875 < 0.75). Drivers: surface 0.35, then air and dew tie at 0.15; `air_temp`
  sorts before `dew_point_spread` by name.
- B. Ts 4.0 is at or above 3: surface 0. Ta 5.0 is at or above 4: air 0. Spread = 5 - 3 = 2.0, between
  0.5 (1.0) and 3.0 (0.0): 1.0 - (2.0 - 0.5) / 2.5 = 0.4. RAIN: 0.5. dTs +0.5 is at or above 0: trend 0.
  Score = 0.15 x 0.4 + 0.20 x 0.5 = 0.06 + 0.10 = 0.16, LOW. Drivers: precipitation 0.10,
  dew_point_spread 0.06, then a three-way tie at 0.0 resolved by name (`air_temp`).
- C. Ts -1.0 lies between -2 (1.0) and 0 (0.5): 1.0 - 0.5 x (-1 + 2) / 2 = 0.75. Ta 0.5 lies between 0
  (0.5) and 4 (0.0): 0.5 - 0.5 x 0.5 / 4 = 0.4375. Spread = 0.5 - (-0.5) = 1.0: 1.0 - (1.0 - 0.5) / 2.5 =
  0.8. SNOW: 0.9. dTs -1.5 lies between -3 (1.0) and -1 (0.5): 1.0 - 0.5 x (-1.5 + 3) / 2 = 0.625.
  Contributions: 0.35 x 0.75 = 0.2625; 0.15 x 0.4375 = 0.065625; 0.15 x 0.8 = 0.12; 0.20 x 0.9 = 0.18;
  0.15 x 0.625 = 0.09375. Sum = 0.721875, HIGH, 0.028 below VERY_HIGH: one more degree of cooling on the
  surface (Ts -2 gives surface 1.0, +0.0875) tips it over. Drivers: surface_temp 0.2625, precipitation
  0.18, dew_point_spread 0.12.

Limitations to state on the dashboard and in the ADR: no validation against outcomes yet; no exposure,
wind or traffic factor; breakpoints are round numbers; stations are point measurements applied to a whole
segment; Frost replay rows get an approximated precipitation type (harness `precip_type`); weights change
only through a pull request that bumps `version`.

Expect: ADR 0005 with the YAML, the definitions and the three examples; `risk_weights.yml` merged; the
three examples reproduced by hand by one reviewer in T3.7.

If it fails: the sum of the weights is not 1.0 (`frostsight.config.risk_config` refuses to load it); a
reviewer gets a different number for C (the usual slip is the sign of dTs: cooling is negative).

---

### T3.5 Gold table contracts      owner: Safiul
Why: dashboards (T3.6 wireframes) and the M5 job are written against these. The DDL is `GOLD_DDL` in
`06_M5` T5.4 `build_gold.py`; keep the two identical.

`gold.road_weather_summary` (MERGE on `(station_id, window_start, window_minutes)`; tumbling windows per
station; `CLUSTER BY (station_id, window_start)`):

| Column | Type |
|---|---|
| station_id, road_segment_id | STRING (segment from the lookup, nullable) |
| window_start, window_end | TIMESTAMP |
| window_minutes | INT: 30, 60, 180, 360 |
| surface_min_c, surface_max_c, surface_mean_c | DOUBLE |
| air_mean_c | DOUBLE |
| precip_sum_mm | DOUBLE: sum of intensity / 6 over 10-minute readings |
| surface_change_c | DOUBLE: last minus first surface reading in the window |
| reading_count | BIGINT |
| computed_at | TIMESTAMP |

`gold.road_segment_current_risk` (MERGE on `road_segment_id`; one row per mapped segment; `CLUSTER BY
(road_segment_id)`):

| Column | Type |
|---|---|
| road_segment_id | STRING |
| station_id | STRING |
| event_time | TIMESTAMP: the observation the score is based on |
| icing_score, risk_score | DOUBLE |
| risk_level | STRING: LOW, MEDIUM, HIGH, VERY_HIGH |
| risk_drivers | ARRAY<STRUCT<factor STRING, contribution DOUBLE>> |
| road_surface_temperature_c, air_temperature_c, dew_point_c, precipitation_type, temperature_change_1h, temperature_change_3h | supporting measurements |
| risk_updated_at | TIMESTAMP |
| model_version | STRING: `v0` |

`gold.road_segment_risk_history`: the same columns, insert-only `MERGE` on `(road_segment_id, event_time)`,
`CLUSTER BY (event_time)`; one row per segment per observation (about 4,300 rows a day), so replay and
validation have full resolution.

`gold.incident_summary` (overwritten every run; one row per segment with active incidents; `CLUSTER BY
(road_segment_id)`): `road_segment_id`, `active_incidents INT`, `incident_types ARRAY<STRING>`,
`max_severity STRING`, `earliest_start TIMESTAMP`, `computed_at`.

`gold.historical_closures` (MERGE on `incident_id`; closed `CLOSURE` incidents with a duration; Sohanur's
label table): `incident_id`, `road_segment_id`, `road_ref`, `start_time`, `end_time`, `duration_min DOUBLE`,
`description`, `computed_at`.

`gold.data_quality_summary` and `gold.data_quality_summary_history`: as in `03_M2` T2.8.

---

### T3.6 Dashboard wireframes      owner: Safiul
Why: the four AI/BI dashboards match the screens in `docs/screens.html` (Risk Map, Road Detail, Gritting Priority List,
Platform Health). Writing the SQL now shows whether the gold contracts carry what the tiles need. Each
dashboard has one dataset per tile; datasets are SQL over gold and silver on the serverless warehouse.
The queries below use full three-part names so they run in SQL Editor; in the dashboard JSON at M6 the
gold names are bare and silver names two-part, because the bundle sets `dataset_catalog` and
`dataset_schema: gold` (`07_M6`). Map tiles: an AI/BI path map draws each segment as a line from a
`GEOMETRY` column, built in the query with `ST_GeomFromText(geometry_wkt_4326, 4326)`; points stay for
incidents and stations. Fallback when spatial SQL is missing on the warehouse, or the lines are too short
to read at county zoom: the segment centroid as a point (07_M6 T6.3).

Dashboard 1, `risk_map`:

```
+-----------------+-----------------+-----------------+-----------------+
| VERY_HIGH  3    | HIGH  12        | Stations 28/30  | Updated 07:08   |
+-----------------+-----------------+-----------------+-----------------+
| Map: segment lines coloured by risk_level             | Legend         |
| Active incidents as a second point layer              | LOW  MEDIUM    |
|                                                        | HIGH VERY_HIGH |
+--------------------------------------------------------+---------------+
| Table: top 10 segments by risk_score with drivers                     |
+------------------------------------------------------------------------+
```

```sql
-- KPI tiles: counts per level, and the freshness stamp
SELECT risk_level, count(*) AS segments FROM frostsight.gold.road_segment_current_risk GROUP BY risk_level;
SELECT count(*) AS reporting FROM frostsight.gold.road_segment_current_risk
WHERE event_time > current_timestamp() - INTERVAL 30 MINUTES;
SELECT max(risk_updated_at) AS updated_at FROM frostsight.gold.road_segment_current_risk;

-- Map layer: one line per segment (path map)
SELECT r.road_segment_id, r.risk_level, r.risk_score, concat(s.road_category, s.road_number) AS road,
       ST_GeomFromText(s.geometry_wkt_4326, 4326) AS geometry
FROM frostsight.gold.road_segment_current_risk r
JOIN frostsight.silver.road_segments s USING (road_segment_id);

-- Incident layer: open incidents (silver.road_incidents already holds the latest version per id)
SELECT incident_id, incident_type, severity, road_ref, start_time, lat AS latitude, lon AS longitude
FROM frostsight.silver.road_incidents
WHERE end_time IS NULL OR end_time > current_timestamp();
```

Dashboard 2, `road_detail` (parameter `segment`, a `road_segment_id`):

```
+------------------------------------------------------------------------+
| E8 1113653-1-9   HIGH 0.62   station 1900177   at 07:00                |
+-------------------------------+----------------------------------------+
| Drivers (bar): surface 0.35   | Surface and air temperature, last 6 h |
|  air 0.15, dew 0.15           | (line, two series)                     |
+-------------------------------+----------------------------------------+
| Risk history, last 24 h (line)| Active incidents on this segment       |
+-------------------------------+----------------------------------------+
```

```sql
SELECT r.*, concat(s.road_category, s.road_number) AS road, s.length_m, s.speed_limit
FROM frostsight.gold.road_segment_current_risk r
JOIN frostsight.silver.road_segments s USING (road_segment_id) WHERE r.road_segment_id = :segment;

SELECT d.factor, d.contribution FROM frostsight.gold.road_segment_current_risk
LATERAL VIEW explode(risk_drivers) t AS d WHERE road_segment_id = :segment;

SELECT o.event_time, o.road_surface_temperature_c, o.air_temperature_c, o.precipitation_type
FROM frostsight.silver.road_weather_observations o
JOIN frostsight.silver.station_segment_lookup l USING (station_id)
WHERE l.road_segment_id = :segment AND o.event_time > current_timestamp() - INTERVAL 6 HOURS ORDER BY 1;

SELECT event_time, risk_score, risk_level FROM frostsight.gold.road_segment_risk_history
WHERE road_segment_id = :segment AND event_time > current_timestamp() - INTERVAL 24 HOURS ORDER BY 1;

SELECT active_incidents, incident_types, max_severity, earliest_start
FROM frostsight.gold.incident_summary WHERE road_segment_id = :segment;
```

Dashboard 3, `priority_list` (parameters `county`, `road_category`):

```
+------------------------------------------------------------------------+
| Filters: county 55   road category E,R,F                               |
+----+----------+------+-------+---------+--------+--------+-------------+
| #  | Road     | Seg  | Score | Level   | Ts °C  | Precip | Drivers     |
| 1  | E8       | ...  | 0.85  | V.HIGH  | -1.0   | SNOW   | surf,prec.. |
+----+----------+------+-------+---------+--------+--------+-------------+
```

```sql
SELECT row_number() OVER (ORDER BY r.risk_score DESC, s.road_category, s.road_number) AS rank,
       concat(s.road_category, s.road_number) AS road, r.road_segment_id, round(r.risk_score, 2) AS score,
       r.risk_level, r.road_surface_temperature_c, r.precipitation_type,
       concat_ws(', ', transform(r.risk_drivers, d -> d.factor)) AS drivers, s.length_m
FROM frostsight.gold.road_segment_current_risk r
JOIN frostsight.silver.road_segments s USING (road_segment_id)
WHERE s.county = :county AND s.road_category IN (:road_category)
  AND r.risk_level IN ('MEDIUM', 'HIGH', 'VERY_HIGH');
```

Dashboard 4, `platform_health`:

```
+------------------+------------------+------------------+------------------+
| road_weather     | incidents        | nvdb             | Quarantined 1h   |
| Fresh  6 min     | Fresh  14 min    | Fresh  2 d       | 37               |
+------------------+------------------+------------------+------------------+
| Rows per source per hour, 24 h (bar)   | DQ failures by rule, 24 h (bar)  |
+----------------------------------------+----------------------------------+
| Last 20 pipeline updates: start, state (table)                            |
+---------------------------------------------------------------------------+
```

```sql
SELECT source, status, round(lag_minutes) AS lag_minutes, last_event_time
FROM frostsight.gold.data_quality_summary;

SELECT sum(quarantined_last_hour) AS quarantined FROM frostsight.gold.data_quality_summary;

SELECT date_trunc('hour', _ingested_at) AS hour, _source, count(*) AS rows
FROM frostsight.silver.road_weather_observations
WHERE _ingested_at > current_timestamp() - INTERVAL 24 HOURS GROUP BY ALL;

SELECT rule_id, sum(failed_records) AS failed FROM frostsight.silver.data_quality_events
WHERE event_time > current_timestamp() - INTERVAL 24 HOURS GROUP BY ALL ORDER BY failed DESC;

-- Pipeline updates from the published event log (resources/ingest.pipeline.yml, event_log: gold.ingest_event_log)
SELECT timestamp, event_type, details:update_progress.state AS state
FROM frostsight.gold.ingest_event_log
WHERE event_type = 'update_progress' ORDER BY timestamp DESC LIMIT 20;
-- verify: if the published table is not available, event_log(TABLE(frostsight.silver.road_weather_observations)) is the TVF form
```

Expect: the four wireframes and their SQL in `docs/dashboards.md`; every column referenced exists
in T3.1, T3.5 or `03_M2` T2.8. A dry check: paste each query into SQL Editor after M4 with `LIMIT 1`; at
M3 they only need to parse (`EXPLAIN` works on empty tables created from the contracts).

If it fails: `ST_Centroid` missing on the warehouse means the map uses precomputed `midpoint_lat`,
`midpoint_lon` columns added to `silver.road_segments` by the reference job; add them to the contract and
to `load_reference.py`.

---

### T3.7 Design review session      owner: Safiul
Why: one 90-minute session closes M3; after it, decisions are ADRs and the build starts.

Agenda:

| Min | Item | Presenter | Output |
|---|---|---|---|
| 0-10 | M2 gate status, what is landing, quota observations | Shawon, Rayhan | context |
| 10-30 | Silver contracts and streaming semantics (T3.1, T3.2) | Sani | ADR 0007 accepted or changed |
| 30-45 | Mapping benchmark result and recommendation (T3.3) | Rayhan | ADR 0006 accepted |
| 45-65 | Risk model v0 with the three worked examples, gold contracts (T3.4, T3.5) | Safiul | ADR 0005 accepted |
| 65-80 | Dashboard wireframes; does every tile have its column | Safiul | `dashboards.md` accepted |
| 80-90 | Labels, leakage rules and time split for the stretch ML (M2 E5 doc) | Sohanur | noted, not blocking |

Sign-off checklist (all yes before M4 starts):

- [ ] Every silver table has a column list and a kind: streaming table, materialized view or job-written
- [ ] Watermark, dedup key, late-data handling, full-refresh rule written as decisions with rationale
- [ ] Mapping method chosen with timings; 500 m acceptance and the quarantine listing of unmapped stations agreed
- [ ] Risk factors, weights, breakpoints, levels and drivers agreed; the three examples reproduced by a second person
- [ ] `risk_weights.yml` and `dq_rules.yml` are the only places thresholds live
- [ ] Each dashboard tile has a query against a contract column
- [ ] Open questions have an owner and a milestone; none is on the M4 critical path

Where decisions are recorded: `docs/adr/0005-risk-model-v0.md`, `docs/adr/0006-station-segment-mapping.md`,
`docs/adr/0007-streaming-semantics.md` at the repo root, using `docs/adr/0000-template.md`. Each ADR has
Context, Options considered, Decision, Consequences, and a "Revisit when" line (for example, 0005: revisit
when S3 produces precision and recall against last winter's incidents).

Expect: three ADRs merged the same week; `contracts.md` and `dashboards.md` merged; the M4 file's tasks
reference them by name.

If it fails: a discussion that does not converge gets a default (the recommendation in this file) and a
dated revisit note in the ADR. The build does not wait.

## Done when

- [ ] `docs/contracts.md` with the five main silver tables, the job-only silver tables, the quarantine shape and the six gold tables
- [ ] ADR 0005, 0006, 0007 merged in `docs/adr/` and linked from `docs/adr/README.md`
- [ ] `sql/benchmarks/00_prepare.sql`, `mapping_h3.sql`, `mapping_st.sql` and the timing numbers in ADR 0006; the `bench_*` tables dropped
- [ ] `config/risk_weights.yml` merged (identical to `06_M5` T5.1); examples A, B, C with arithmetic in the ADR
- [ ] `docs/dashboards.md` with four wireframes and their SQL
- [ ] Review session held; checklist all yes

## Verify

```bash
cd project
ls docs/contracts.md docs/dashboards.md config/risk_weights.yml sql/benchmarks/00_prepare.sql sql/benchmarks/mapping_h3.sql sql/benchmarks/mapping_st.sql
ls ../docs/adr/0005-risk-model-v0.md ../docs/adr/0006-station-segment-mapping.md ../docs/adr/0007-streaming-semantics.md
uv run python -c "import yaml; c=yaml.safe_load(open('config/risk_weights.yml')); w=c['weights']; assert abs(sum(w.values())-1)<1e-9; assert set(w)=={'surface_temp','air_temp','dew_point_spread','precipitation','temp_trend_1h'}; print('weights ok', c['version'])"
```

```sql
-- On the serverless warehouse: the function checks from T3.3 step 1, then the benchmark inputs
SELECT count(*) AS stations FROM frostsight.silver.bench_stations;      -- expect 30
SELECT count(*) AS segments, avg(size(h3_cells)) AS cells_per_segment FROM frostsight.silver.bench_segments;   -- about 20,000; a few cells each
```
