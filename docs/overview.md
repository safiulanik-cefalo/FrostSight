# FrostSight overview

FrostSight estimates and explains winter road hazard on the Norwegian road network. It combines
10-minute road-weather measurements, road incidents, the national road database (NVDB), terrain and
historical accidents and slides into a risk level per road segment, with the measurements that drive it.

The question it answers: given current conditions, road geometry and history, which road segments are
likely to become hazardous or disrupted, and why?

## Scope

| | MVP | Stretch | Later |
|---|---|---|---|
| Area | One pilot county, Troms (NVDB `fylke=55`) | | National |
| Sources | DATEX II road weather and incidents, NVDB, MET Frost history, Open-Meteo elevation | | Traffic (trafikkdata), MET forecasts |
| Risk | Deterministic icing score per segment with top drivers | Historical baselines and anomalies | Closure and accident risk |
| Output | Risk map, road detail, gritting priority list, platform health | Storm replay, alerts, API, ML predictions for 1, 3 and 6 hours | Routing, CCTV links |

FrostSight is not an official warning service and does not replace Statens vegvesen traffic information.
Every output carries its timestamp and data freshness.

## Ownership

| Role | Owner | GitHub | Owns |
|---|---|---|---|
| E1 Ingestion and streaming | Shaid Hasan Shawon | @pyshawon | Collector, API clients, bronze, streaming ingestion, checkpoints, schema evolution |
| E2 Lakehouse and transformations | Nazmul Hasan Sani | @sani1994 | Silver, dedup, event-time windows and trends, replay mechanics, performance |
| E3 Geospatial, data quality and governance | Saiful Islam Rayhan | @sirayhancse | Road-segment model, station mapping, data-quality rules and quarantine, Unity Catalog, bundle and CI, monitoring |
| E4 Architecture, analytics and product | Safiul Anik | @safiulanik-cefalo | Architecture, integrations, ADRs, gold tables, risk engine, dashboards, API |
| E5 ML and prediction | Md. Sohanur Rahman | (to add) | Labels, features, models, batch prediction |

Milestones M0 to M7 (MVP) and S1 to S3 (stretch) are in [`plan/`](plan/00_README.md). They have an order,
not dates.

## Users and use cases

Six personas. MVP column follows spec section 31: road-weather streaming, incident feed, NVDB reference, medallion, observation-to-segment mapping, DQ, temperature trends, historical road-weather and incident analytics, icing risk with drivers, risk map, freshness monitoring. Traffic, closure/accident risk, ML, replay, routing, CCTV and alert delivery are post-MVP.

**P1 Private driver / commuter** — checks a route before leaving.

| ID | Use case | Trigger | What the user sees / gets | Data needed | MVP? |
|---|---|---|---|---|---|
| WR-UC-01 | Current icing risk on my route | Before departure | Map with segments coloured LOW..VERY_HIGH, last-updated time | gold.road_segment_current_risk, silver.road_segments | ✅ |
| WR-UC-02 | Why is this segment HIGH | Click segment on map | Road detail: risk per type, top risk_drivers, nearest station readings | gold.road_segment_current_risk, silver.road_weather_observations, silver.road_weather_stations | ✅ |
| WR-UC-03 | Closures and accidents on my route | Before departure | Active incidents overlaid on map with start time and type | silver.road_incidents | ✅ |
| WR-UC-04 | Risk at my planned departure time | Choose 1h/3h/6h horizon | Predicted risk level per segment with model version and confidence | gold.road_segment_predicted_risk | ✗ (ML) |
| WR-UC-05 | Lower-risk alternative route | Segment on route is VERY_HIGH | Suggested alternative with its risk | NVDB graph + current risk | ✗ (future) |

**P2 Haulage / bus fleet dispatcher** — watches a handful of corridors all day.

| ID | Use case | Trigger | What the user sees / gets | Data needed | MVP? |
|---|---|---|---|---|---|
| WR-UC-06 | Corridor risk board refreshed every 10 min | Continuous | Filtered map and table for saved corridors, freshness indicator | gold.road_segment_current_risk, gold.data_quality_summary | ✅ |
| WR-UC-07 | Alert when a corridor segment enters HIGH/VERY_HIGH | Risk level change | Alert with segment, severity, risk type, trigger, measurements, timestamp | gold.road_segment_risk_history | ✗ (alerts) |
| WR-UC-08 | Wind warning on exposed stretch (fjord crossing, mountain pass) | Wind over threshold | Closure-risk alert with exposure indicator | closure risk, silver.terrain_grid, silver.road_segments | ✗ (closure risk) |
| WR-UC-09 | Traffic speed and volume on corridor during a storm | Storm in progress | Traffic vs typical-hour baseline per registration point | silver.traffic_observations, gold.traffic_summary, gold.historical_baselines | ✗ (traffic) |

**P3 Statens vegvesen traffic-centre operator (VTS)** — county-wide situational awareness.

| ID | Use case | Trigger | What the user sees / gets | Data needed | MVP? |
|---|---|---|---|---|---|
| WR-UC-10 | County situation board | Shift start, continuous | Segments at HIGH/VERY_HIGH, active incidents, station readings, county summary | gold.road_segment_current_risk, gold.incident_summary, silver.admin_boundaries | ✅ |
| WR-UC-11 | Rapid surface-temperature drop detected | temperature_change_1h below threshold | Segment list with 1h/3h trend and precipitation, visible on dashboard | road_weather_1h / _3h windows | ✅ (dashboard; push alert ✗) |
| WR-UC-12 | Is this drop unusual for this segment | Operator drills into segment | Current 3h drop vs historical 95th percentile, anomaly % | gold.historical_baselines | ✗ (baselines) |
| WR-UC-13 | Replay last week's storm hour by hour | Post-event review | Risk map stepping through event time with incidents overlaid | gold.replay_events, gold.road_segment_risk_history | ✗ (replay) |

**P4 Winter-maintenance contractor (gritting / ploughing)** — decides where to send trucks.

| ID | Use case | Trigger | What the user sees / gets | Data needed | MVP? |
|---|---|---|---|---|---|
| WR-UC-14 | Segments in my contract area crossing 0 °C with precipitation | Every 10 min | Segment list with surface temp, air temp, precip type, icing drivers | icing risk, silver.road_weather_observations | ✅ |
| WR-UC-15 | Ranked gritting priority list | Shift planning | Table of segments in area sorted by icing score, then road class | gold.road_segment_current_risk, silver.road_segments | ✅ |
| WR-UC-16 | When does surface temperature typically dip below 0 on my segments | Seasonal planning | Hour-of-day and month profile per segment | gold.road_weather_summary, historical road-weather | ✅ |

**P5 Road-safety analyst / researcher** — historical questions in SQL.

| ID | Use case | Trigger | What the user sees / gets | Data needed | MVP? |
|---|---|---|---|---|---|
| WR-UC-17 | Segments closed most often in winter, with typical duration | Ad-hoc query | Ranked table, closure duration by cause | gold.historical_closures, silver.road_incidents | ✅ |
| WR-UC-18 | Highest winter accident rate per km | Ad-hoc query | Ranked segments, accident type and severity split | gold.historical_accidents, silver.accidents (WFS, 5 yr) | ✗ (accidents) |
| WR-UC-19 | Weather conditions in the 6 h before closures | Ad-hoc query | Distribution of surface temp, precip, wind preceding closure events | silver.road_weather_observations joined to silver.road_incidents by segment and time | ✅ |
| WR-UC-20 | Roads repeatedly hit by avalanche or landslide | Ad-hoc query | Segment list with event count and road impact | silver.avalanche_landslide_events | ✗ |
| WR-UC-21 | Did the risk score precede observed incidents | Model / rule evaluation | Precision, recall, lead time per segment and window | gold.road_segment_risk_history vs silver.road_incidents / accidents | ✗ (validation) |
| WR-UC-22 | Export one storm's replay for a paper | Research request | gold.replay_events extract via SQL or API | gold.replay_events | ✗ (replay) |

**P6 Platform operator** — keeps the pipelines honest.

| ID | Use case | Trigger | What the user sees / gets | Data needed | MVP? |
|---|---|---|---|---|---|
| WR-UC-23 | Freshness and pipeline health board | Continuous | Per-source last ingestion, event-time lag, stale flag (10-min threshold for road weather, daily for reference data), streaming latency | gold.data_quality_summary, pipeline event log | ✅ |
| WR-UC-24 | Quarantine review | Daily or on DQ alert | Counts and samples by rule: invalid_road_weather, invalid_incidents, unmapped_observations, schema_errors | quarantine.*, silver.data_quality_events | ✅ |
| WR-UC-25 | Backfill or reprocess a date range | Source outage, rule change | Job parameterised by date range re-runs bronze → gold idempotently, replay-vs-live diff report | bronze.* with _batch_id, checkpoints | ✗ (Phase 7, but needed for replay) |

Count: 25 use cases, 13 MVP.
