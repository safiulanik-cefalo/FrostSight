# Stretch review: files 10 to 12, and what they changed in files 00 to 08

Date: 29 September 2026. Reviewer: Safiul (with Claude). Scope: `10_S1_replay.md`, `11_S2_baselines_alerts_api.md`,
`12_S3_ml.md` against `00_README.md` (contract), `09_MVP_review.md` (open items) and the parts of 03, 05, 06,
07 and 08 they build on. References used: the `databricks-pipelines` (streaming-table-python,
expectations-python), `databricks-dabs` (bundle-structure, alerts, resource-permissions), `databricks-jobs`
(task-types, notifications-monitoring), `databricks-apps-python` and `databricks-ml-training` skills. The
Databricks CLI is not installed on the review machine, so anything that needs a workspace is listed under
"Still to verify", with the exact command.

Principle: when a stretch decision changes how an MVP table or job must be built, the change goes into the
MVP file, so the team builds it once, correctly, and the stretch file only checks it. S1's decisions D1
(history marker), D2 (two silver flows) and D3 (run suffix) are now MVP behaviour. S1 no longer needs a
code change or a full refresh of silver.

Checks run after editing: every Python block in 00, 02, 03, 05 to 08 and 10 to 12 parses with `ast.parse`
(53 blocks; the one fragment, the `GOLD_DDL` entry in 11 S2.1.3, parses as a dict entry); every YAML block
loads with PyYAML (32 blocks); the harness `landing_path` from 03 was run offline and its output split on `__`
gives the event id at part 2, as `batch_id_from_path` expects; every task in 10, 11 and 12 has
owner / Why / Do / Expect / If it fails; each file has "Done when" and "Verify"; every `environments.spec`
has `client: "4"`; every schedule uses `pause_status: ${var.schedule_pause_status}`; permission levels match
the dabs reference (jobs `CAN_MANAGE_RUN`, dashboards `CAN_READ`, alerts `CAN_RUN`, apps `CAN_USE`,
registered model `grants` with `EXECUTE`); bundle variables used in 10 to 12 are all in the README table
(one was missing: `slack_destination_id`, now added).

## Back-propagated into MVP files

| File | Task | Change |
|---|---|---|
| 00 | section 4 naming | Replay file name is `replay__<event_id>__<UTC ts>__r<UTC run start>.jsonl`, with the reason (Auto Loader never re-reads a seen path). New row: silver road weather is one streaming table with two flows, `road_weather_live` and `road_weather_replay` |
| 00 | section 2 variables | Added `slack_destination_id` (S2 only, default `""`) |
| 02 | intro, T1.9 | Replay file name with the run suffix |
| 03 | T2.6 | Harness: `landing_path(bucket, event_id, run)`, `--run` flag (default `r<UTC start>`, no `__` allowed), final `run <r>: <n> files` line, expected listing with the suffix. New docstring paragraph: every harness file is a replay file, so `--latest` goes through the replay flow; it is not deduplicated against live rows and is not late relative to the live watermark. The live duplicate and late tests are the hand-made files of 05 T4.8 steps 4 and 5; `--latest` stays on `personal` with cleanup |
| 05 | section 1 | Replay name with run suffix; new decision row "live and replay flows" with the watermark reason |
| 05 | T4.2 | `transforms.normalise_road_weather(b)` (moved from S1 T-S1.2 into the package from the start; `DataFrame` import); `batch_id_from_path` docstring shows the four-part replay name |
| 05 | T4.4 | `silver.road_weather_observations` is `dp.create_streaming_table` (with `expect_all_or_drop=HARD`, `expect_all=SOFT`) fed by `@dp.append_flow` `road_weather_live` (`NOT (_batch_id LIKE 'replay:%')`) and `road_weather_replay` (`LIKE 'replay:%'`); one helper `_normalised(filter)` builds each slice with its own watermark and `dropDuplicatesWithinWatermark`; bronze read with `skipChangeCommits`; `quarantine.invalid_road_weather` is a `create_streaming_table` with two append flows `invalid_road_weather_live/_replay`. Step 1 explains why (one watermark per streaming query) and the consequences (per-flow dedup, one replay event at a time). New step 5: verify expectations per flow, fallback to decorators on the flows. Expect names both flows |
| 05 | T4.8 step 2 | Event-log filter is `origin.flow_name RLIKE 'road_weather_(live\|replay)$'`, not `LIKE '%road_weather_observations'`. The brief proposed `LIKE '%road_weather_%'`; that also matches the bronze flow `road_weather_events` and the quarantine flows `invalid_road_weather_*`, so the pattern names the two flows (open question 1) |
| 05 | T4.8 step 5 | Late file: the 2-hour rows are dropped by the live flow and appear only in bronze and in `quarantine.late_road_weather` (RW008, 07 T6.2); the file is live-named, so it tests the live flow |
| 05 | T4.9, Done when | `test_batch_id` has the four-part replay path; Done when names both flows and the shared normalisation |
| 06 | decisions | History row: key `(road_segment_id, event_time, _batch_id)`, `_batch_id` is the silver marker. Replay row: `--event-id` scores an event into history only; live readers of history filter `coalesce(_batch_id,'') NOT LIKE 'replay:%'` |
| 06 | T5.1 | `config.replay_event(event_id)` added next to `risk_config` |
| 06 | T5.4 | `RISK_COLS`, `HISTORY_KEY`; history DDL = current-risk columns plus `_batch_id STRING`; `_scored()` helper; `build()` writes current risk from `RISK_COLS` and history with `_batch_id`; new `build_replay()` (silver replay rows, excluding `replay:latest_%`, inside the event window; trends inside the window; history only, marker `replay:<event_id>` as a literal) and `--event-id`. Step 3 explains why `--since-hours` cannot backfill risk history (`latest_per_station` keeps only readings under 30 minutes old). "If it fails" has the `ALTER TABLE ... ADD COLUMNS` fix for a table created earlier |
| 06 | T5.5 step 4 | Concurrency note rewritten: the limit counts running task runs; serial chains hold one each; scheduled peak with all stretch jobs is 3; points to the table below |
| 06 | T5.7, section 3, Done when | `rows = keys` counts `(road_segment_id, event_time, _batch_id)`; the history backfill is `--event-id`, `--since-hours 168` rebuilds only the window table |
| 07 | T6.2 | `quarantine_late_rows` skips `_batch_id LIKE 'replay:%'` (every replayed row is months "late" by ingestion time and would flood `quarantine.late_road_weather`) |
| 07 | T6.4 | `ds_risk_history` and `ds_latency` get `AND coalesce(_batch_id, '') NOT LIKE 'replay:%'`, plus the rule for every live history query |
| 08 | T7.2 step 2 | "silver keeps them" replaced: late rows are dropped; visible in bronze and `quarantine.late_road_weather`; Frost history goes through the replay flow; a late live file needs a silver full refresh |
| 08 | T7.2 step 2 (full refresh) | Gold rebuild: `--since-hours 168` rebuilds windows only; history for a replayed event is `build_gold.py --event-id` |
| 08 | T7.7 | Ingestion runbook: replay file name with run suffix, replay flow; analytics runbook backfill uses `--event-id` and the live filter |
| 08 | T7.8 | S1 done: S1's `FrostSight · Storm replay` dashboard **supersedes** `risk_map_replay`. Not done: harness, one update, `build_gold.py --event-id` (the old `--since-hours 48 --include-replay` could never score last winter's readings); `risk_map_replay` dataset filters `_batch_id LIKE 'replay:%'`; demo minute 4-8 names both options |
| 08 | Verify | Day-`D` history count filters replay rows |

## Fixed in stretch files

| File | Task | Change |
|---|---|---|
| 10 | section 0, D2, D3, task table | Point at the MVP files that now hold D1 to D3; D2 adds the backfill case (a whole-winter backfill moves the replay watermark to March, so a later storm replay is dropped as late unless the D3 reset runs); D3 command has `--profile` |
| 10 | T-S1.1 to T-S1.3 | Rewritten as checks (grep, event-log query, unit test) against 06 T5.4, 05 T4.4 and 03 T2.6 instead of carrying a second copy of the code. The single-flow migration and its selective full refresh survive only as a conditional step for a workspace built before this review. Timing proof and harness rules kept |
| 10 | T-S1.4, T-S1.6 | Catalogue `rows_silver`, check A and check B select silver replay rows by event window (excluding `replay:latest_%`), matching `build_replay`, so the event is scored and tested even when its readings arrived as `replay:backfill_<day>` rows; check A uses `[start, end)` like the harness, B uses `[start, end]` like `build_replay` |
| 10 | T-S1.6 "If it fails", Done when | Import error text points at 05 T4.2; Done when no longer asks for the one-off full refresh and checks both flow names in the event log |
| 11 | S2.2.1, S2.2.2 | A1 and A2 (SQL and bundle YAML) exclude `coalesce(_batch_id,'') NOT LIKE 'replay:%'`. The claim that `--include-replay` makes A1 fire on the replayed storm day was wrong (replay rows have last winter's `event_time`, outside the 2-hour window); replaced by "replays never trigger A1/A2" and a pointer to the forced STALE test |
| 11 | S2.1.2 step 2 | Task budget restated on running tasks (peak 2, 3 when `predict` overlaps); fallback `baselines` job cron moved to `"0 20 3 ? * TUE"` to avoid `:00` and `:35` |
| 11 | S2.1.3 step 1 | `anomalies(catalog, scored)` goes after the history MERGE in `build()`; `build_replay` does not call it |
| 11 | decisions, handover | Apps budget no longer reserves slots for an S3 model UI (S1 and S3 deploy no app). Handover row "S3 gets baselines as feature source" removed: S3 must not read S2 (leakage, below) |
| 12 | T-S3.2 | Leakage note made explicit: S3 reads neither `gold.historical_baselines` nor `gold.road_segment_anomalies`, because both summarise the whole of last winter, which is S3's train, validation and test period |
| 12 | T-S3.3, T-S3.4, T-S3.5 | `--model-name` on `train.py`, `compare_deterministic.py` and `predict.py`; `mode: development` on `personal` renames the registered model to `dev_<you>_hazard_model`, and the scripts hard-coded `hazard_model` (the old text said "`train.py --model-name` must then match" but the flag did not exist) |
| 12 | T-S3.4 | Bug: `with_risk` reads `dew_point_c`, which the feature table does not carry (only `dew_point_spread_c`); the comparison would fail with an unresolved column. `dew_point_c` is rebuilt as `air_temperature_c - dew_point_spread_c` |
| 12 | T-S3.4, T-S3.5 | Model input cast to `float64` before `predict` (the signature was logged from float64 columns; int indicator columns would otherwise meet schema enforcement) |
| 12 | T-S3.5, T-S3.7 | `predict.job.yml` passes `--model-name` from job parameter `model_name` = `${resources.registered_models.hazard_model.name}`; `queue.enabled`. `train.job.yml` gets the weekly schedule (Sunday 04:05 UTC, `schedule_pause_status`), `queue.enabled`, failure email, `model_name` and `experiment` (`${resources.experiments.frostsight.name}`, which carries the dev prefix on `personal`) parameters; a scheduled run never promotes |
| 12 | T-S3.5 step 2 | Task-budget paragraph restated with the real schedule and the running-task rule |
| 12 | T-S3.4 step 2 | Live-winter SQL on history filters replay rows |
| 12 | T-S3.7, Done when | Naming under `mode: development` explained for models and experiments, with a verify command and a per-target fallback; Done when records the weekly `train` |

Confirmed without change: S3's unit of prediction is the station catchment (the `road_segment_id` of the
station's lookup row, one station per segment, events attributed within 15 km); S3 depends on no S2 table.
Column names used in 10 to 12 match the contracts in 05 T4.4/T4.6 (`silver.road_incidents`, `silver.accidents`
`accident_id/severity/event_time/wkt_4326`, `silver.avalanche_landslide_events` `event_id/event_type/road_closure`,
`silver.road_segments` `geometry_wkt_25833/h3_cells/elevation_m/road_category/speed_limit/length_m/centroid_*`),
06 `GOLD_DDL`, and 07 (`v_segments`, `v_incidents.is_active`, `data_quality_summary`, `data_quality_events`).

## Task and schedule budget on Free Edition

The limit (README section 2) is 5 task runs **running** at the same moment in the account. Every job in the
bundle is a serial chain (`depends_on` one after the other) with `max_concurrent_runs: 1`, so a job holds at
most one of the five while it runs, whatever number of tasks it defines. SQL alerts and dashboards run on the
warehouse and are not job tasks. The collector on `free` runs in GitHub Actions and does not count.

| Job | Defined tasks | Schedule (UTC, Quartz) | Typical duration | Running tasks it can hold |
|---|---|---|---|---|
| `orchestrate` | 3 (pipeline update, build_gold with S2 anomaly step, build_freshness) | `0 0/10 * * * ?` | 4 to 7 min | 1 |
| `reference` | 3 (load_reference, optimize_gold, build_baselines from S2) | `0 0 3 ? * MON` | 20 to 40 min | 1 |
| `predict` (S3) | 1 | `0 35 * * * ?` | 3 to 5 min | 1 |
| `train` (S3) | 5 (labels, features, train, compare, data tests) | `0 5 4 ? * SUN` | under 30 min | 1 |
| `replay` (S1) | 4 (pipeline sweep, build_gold `--event-id`, snapshots, equivalence) | none, by hand | 15 to 25 min | 1 |
| fallback `baselines` (S2, only if Monday queues) | 1 | `0 20 3 ? * TUE` | under 20 min | 1 |

| Overlap window | Jobs running | Running tasks |
|---|---|---|
| Any 10-minute slot | `orchestrate` | 1 |
| Every hour, :35 to :40 | `orchestrate` (the :30 run, until about :37) + `predict` | 2 |
| Monday 03:00 to about 03:40 | `orchestrate` + `reference` (+ `predict` at 03:35) | 3 |
| Sunday 04:05 to about 04:35 | `orchestrate` + `train` (+ `predict` at 04:35 if `train` overruns) | 3 |
| Tuesday 03:20 (fallback only) | `orchestrate` + `baselines` | 2 |
| `replay` started by hand, any other time | `orchestrate` + `replay` (+ `predict`) | 3 |
| Worst case, every rule broken (replay and a manual train during Monday 03:35) | all five jobs | 5 |

No overlap exceeds 5; the scheduled peak is 3. Team rules: never start `replay` or `train` by hand on Monday
03:00 to 04:00 or Sunday 04:00 to 05:00 UTC; start `replay` right after an `orchestrate` run has finished
(its pipeline sweep cannot run while `orchestrate`'s update of the same pipeline is running; that is a
one-update-per-pipeline rule, separate from the task budget). `queue.enabled` on `predict` and `train` makes a
run wait rather than fail if the limit is hit anyway. No cron minutes needed moving except the S2 fallback.

## Still to verify on a real workspace

| File | Item | Command |
|---|---|---|
| 05 T4.4 | `dp.create_streaming_table(expect_all_or_drop=..., expect_all=...)` applies to both append flows and reports counts per `origin.flow_name` | after one update with a replay file on `personal`: `databricks experimental aitools tools query --warehouse $WH --profile frostsight-personal "SELECT origin.flow_name, count(*) FROM frostsight.gold.ingest_event_log WHERE event_type = 'flow_progress' AND details:flow_progress.data_quality IS NOT NULL GROUP BY 1"` |
| 05 T4.4 | Whether `origin.flow_name` is bare (`road_weather_live`) or qualified; the `RLIKE ... $` filter works for both | same query without the `data_quality` filter |
| 05 T4.4 | `skipChangeCommits` on a streaming read of a table owned by the same pipeline | `databricks pipelines list-pipeline-events <pipeline_id> --profile frostsight-personal \| jq '.events[] \| select(.level=="ERROR") \| .message'` after the first deploy |
| 05 T4.4, 10 T-S1.2 | A replay run at ×600 lands every row through `road_weather_replay` while `road_weather_live` keeps its watermark at "now" | `uv run python -m replay.harness --event <id> --speed 600 --target personal`, `databricks bundle run ingest -t personal --profile frostsight-personal`, then `SELECT count(*) FROM frostsight.silver.road_weather_observations WHERE _batch_id = 'replay:<id>'` equals the file line count minus duplicates |
| 06 T5.4 | `build_replay` row count and that `current_risk` is untouched | `python src/jobs/build_gold.py --catalog frostsight --event-id <id>` on serverless, then `SELECT _batch_id, count(*) FROM frostsight.gold.road_segment_risk_history GROUP BY 1` and `SELECT max(event_time) FROM frostsight.gold.road_segment_current_risk` |
| 12 T-S3.5, T-S3.7 | `queue: { enabled: true }` accepted and applied to the account concurrency limit | `databricks bundle validate -t free --strict --profile frostsight-free`; `databricks jobs get <predict id> --profile frostsight-free \| jq .settings.queue` |
| 13 budget | The 5-task limit counts running task runs, not defined ones, and what a sixth does | start `train` and `replay` by hand while `orchestrate` runs; `databricks jobs list-runs --active-only --profile frostsight-free -o json \| jq '.runs[] \| {job_id, state}'` |
| 10 T-S1.4 | `pipeline_task` behaviour when an update of the same pipeline is already running | `databricks jobs get-run --run-id <replay run id> --profile frostsight-free \| jq '.tasks[0].state'` |
| 12 T-S3.7 | `${resources.registered_models.hazard_model.name}` and `${resources.experiments.frostsight.name}` resolve inside job parameters | `databricks bundle validate -t personal --profile frostsight-personal -o json \| jq '.resources.jobs.predict.parameters, .resources.jobs.train.parameters'` |
| 11 S2.3.3, 12 T-S3.7 | `mode: development` names on `personal`: registered model `dev_<you>_hazard_model`, experiment `[dev <you>]` prefix, app name left alone or prefixed | `databricks bundle validate -t personal --profile frostsight-personal -o json \| jq '.resources.registered_models.hazard_model.name, .resources.experiments.frostsight.name, .resources.apps.api.name'` |
| 12 T-S3.4 | MLflow schema enforcement accepts the float64 frame; `infer_signature` from float64 matches | `databricks bundle run train -t personal --profile frostsight-personal`, task `compare` log |
| 12 T-S3.7 | An empty `promote` job parameter reaches `train.py` as an empty argument | `databricks jobs get-run --run-id <train run id> --profile frostsight-personal \| jq '.tasks[] \| select(.task_key=="train") \| .spark_python_task.parameters'` |
| 11 S2.2.2 | Alerts v2 keys `aggregation`, `empty_result_state`, `retrigger_seconds`, `custom_*`; `presets.trigger_pause_status` does not override the alert `pause_status` on `free` | `databricks bundle schema \| grep -A 120 'sql.AlertV2' \| grep -E 'aggregation\|empty_result_state\|retrigger\|custom_'`; `databricks bundle validate -t free --strict --profile frostsight-free -o json \| jq '.resources.alerts[].schedule.pause_status'` |
| 10 T-S1.7 | `filter-single-select` with a value-list field and several `parameterName` bindings | open the deployed replay dashboard in edit mode; record the outcome here |
| 06 T5.5 | `OPTIMIZE`/`VACUUM` from a job on pipeline-owned `bronze.road_weather_events` and `silver.road_weather_observations` (pipelines maintain their own tables) | `databricks bundle run reference -t personal --profile frostsight-personal`, task `optimize_gold` log |

## Open questions for the team

1. **Event-log flow filter.** The brief asked for `flow_name LIKE '%road_weather_%'`; that also matches
   `road_weather_events` and `invalid_road_weather_*`. 05 uses `RLIKE 'road_weather_(live|replay)$'`. Sani
   to confirm after the first update (see verify row 2).
2. **Harness `--latest` mode.** Under two flows it creates live/replay pairs with the same key in silver,
   breaking the `n = n_distinct` checks in 05 and 08 until deleted. The M4 tests no longer need it. Drop the
   mode, or keep it `personal`-only with cleanup (current text)? Owner: Sani.
3. **Order of backfill and storm replay on `free`.** A whole-winter backfill (S2, S3) moves the replay
   watermark to March; a storm replayed after it is dropped as late and scored from the backfill rows (same
   values). To demo "storm through the live pipeline", run the S1 storm first or do the D3 reset. Decide the
   order at the S1 kick-off. Owner: Sani, Shawon.
4. **Freshness counts during a replay.** 07 `build_summary` counts `rows_last_24h` from silver by
   `_ingested_at`, so replayed rows inflate the road-weather count on replay days. Add
   `_batch_id NOT LIKE 'replay:%'` to that count (needs a per-source filter in `SourceSpec`)? Owner: Safiul.
5. **Weekly `train`.** The Sunday run exists to refresh `ml.events` for `predict`; it also registers a new
   `@challenger` version from the same training window every week. Alternative: a one-task weekly
   `build_labels` job and a manual `train`. Owner: Sohanur.
6. **08 T7.2 diff query** compares live and replay silver rows of day `D`; for a day from last winter
   there are no live rows, so it only proves something for a day that was also collected live. Keep it for
   this winter's days, or replace it with S1's equivalence test? Owner: Shawon.
7. **08 T7.9 S3 handover row** says features come from `gold.road_segment_risk_history` and
   `gold.road_weather_summary`; S3 builds them from silver. Update the row or leave it as history. Owner: Safiul.
