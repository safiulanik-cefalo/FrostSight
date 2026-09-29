# M2: Foundation ready (gate)

Owners: Rayhan (Unity Catalog check, bundle, CI), Shawon (collector deployment), Sani (replay harness), Safiul
(gate decision). Read `00_README.md` first. Everything here assumes M0 (accounts, CLI profiles
`frostsight-free`, `frostsight-personal`, source credentials, `pyproject.toml`) and M1 (catalog,
schemas and landing volume from `sql/001_catalog_schemas_volume.sql`; collector package; NVDB extract; last
winter's history in `frost_history/`; contract v1) are done.

Goal: the Unity Catalog layout is confirmed on the team workspace and every personal one; the bundle
skeleton deploys to `personal` and `free` and validates for `aws`; CI runs on every pull request; the
collector runs on a schedule outside Databricks and lands files; the replay harness writes historical files
in the live file format; the M2 gate passes, meaning the three MVP sources (road weather, incidents, NVDB)
are landing real files.

Why this milestone is a gate: after M2 the team spends its build effort (M4 to M7) on this platform. If any
MVP source is not landing files by now, the project changes shape. Section "M2 gate" has the decision.

Commands run from the repo root unless stated. Every CLI call carries `--profile frostsight-free` (team
workspace) or `--profile frostsight-personal` (your own); bundle commands take the profile from the target's
`workspace.profile`, so they need only `-t <target>`.

What the bundle owns and what it does not (README section 2, rule 5): the bundle deploys the pipeline, the
jobs and (from M6) the dashboards. The catalog, schemas, landing volume and grants come from
`sql/001_catalog_schemas_volume.sql`, run once per workspace at M1. There is no `catalog.schema.yml`
resource: `mode: development` renames bundle resources, and the docs do not promise it leaves schemas alone.

---

### T2.1 Unity Catalog layout confirmed      owner: Rayhan
Why: every job, pipeline and dashboard is written once against fixed names; before the bundle deploys, prove
the names, the grants and the volume are in place on the team workspace and on every personal one.

Do:
1. If M1 T1.1 was not run in a workspace, run `sql/001_catalog_schemas_volume.sql` there now (SQL
   editor, serverless warehouse, Run all). It is idempotent. The per-user `GRANT` block is for the team
   workspace only.
2. Check the names and grants from the CLI:

```bash
databricks schemas list frostsight --profile frostsight-free            # landing, bronze, silver, gold, quarantine, ml
databricks experimental aitools tools query "SHOW GRANTS ON SCHEMA frostsight.silver" --profile frostsight-free
databricks experimental aitools tools query "SHOW GRANTS ON VOLUME frostsight.landing.raw" --profile frostsight-free
```

3. Test the volume from your laptop:

```bash
echo '{"probe": true}' > /tmp/probe.json
databricks fs cp /tmp/probe.json dbfs:/Volumes/frostsight/landing/raw/_probe/probe.json --profile frostsight-free
databricks fs ls dbfs:/Volumes/frostsight/landing/raw/ --profile frostsight-free
databricks fs rm dbfs:/Volumes/frostsight/landing/raw/_probe/probe.json --profile frostsight-free
```

4. Ownership reminder. The admin who ran the script owns the catalog, schemas and volume and is the only one
   who can `GRANT` on them. Tables are owned by whoever creates them; the pipeline's tables are owned by the
   identity that deploys `free` (the admin, through CI). On AWS at M4, transfer schema ownership to the
   service principal that runs the jobs so that pipeline-created tables do not depend on a person.

Expect: six schemas; `SHOW GRANTS` lists `USE_SCHEMA`, `CREATE_TABLE`, `CREATE_MATERIALIZED_VIEW`, `SELECT`,
`MODIFY` per engineer on `silver`; `fs ls` shows `_probe/` beside the fifteen M1 folders
(`road_weather/`, `road_incidents/`, `nvdb_road_network/`, `frost_history/`, ...).

If it fails:
- `PERMISSION_DENIED ... USE SCHEMA`: the user has `SELECT` but not the traversal grant. Data access needs
  `USE CATALOG` and `USE SCHEMA` as well; re-run the grant block.
- `Principal not found`: the email differs from the sign-in identity, or the group was written as `users`
  instead of `account users`. Check Settings, Identity and access, Users, and copy the exact string.
- `databricks fs cp` says `no such directory`: the `dbfs:` prefix is missing on the volume path.

---

### T2.2 Bundle skeleton with three targets      owner: Rayhan
Why: one `databricks.yml` describes the pipeline, jobs and dashboards; `databricks bundle deploy -t <target>`
creates them. The code is identical per target, only variables differ (00_README section 2). The variable
names, defaults and per-target values below are the README table, verbatim; change them there first.

Do:
1. Create `databricks.yml`:

```yaml
bundle:
  name: frostsight

include:
  - resources/*.yml

# Bundle variables. The authoritative list is the table in 00_README section 2 ("Bundle variables and
# targets"). Nothing target-specific is hard-coded in Python or SQL.
variables:
  catalog:
    description: Unity Catalog catalog; created by sql/001_catalog_schemas_volume.sql, never by the bundle
    default: frostsight
  landing_root:
    description: Landing volume root the collector writes and Auto Loader reads
    default: /Volumes/frostsight/landing/raw
  pilot_county:
    description: NVDB fylke number, as a string
    default: "55"
  warehouse_name:
    description: SQL warehouse for dashboards; check the exact name with `databricks warehouses list`
    default: "Serverless Starter Warehouse"
  warehouse_id:
    description: Resolved from warehouse_name at validate/deploy time
    lookup:
      warehouse: ${var.warehouse_name}
  schedule_pause_status:
    description: PAUSED or UNPAUSED. The job schedule field takes this enum, not a boolean
    default: UNPAUSED
  pipeline_continuous:
    description: true only where a 24x7 stream is affordable (an aws test)
    default: false
  pipeline_development:
    description: Pipeline development mode (compute reuse, no retries)
    default: true
  notification_email:
    description: Failure emails from jobs and the pipeline
    default: safiul.kabir@cefalo.no
  config_dir:
    description: Where config/*.yml lands in the workspace; jobs and the pipeline read it from here
    default: ${workspace.file_path}/config

# The Python package built from src/frostsight and collector/, uploaded with the bundle. Job environments
# install it as ../dist/*.whl (resources/*.yml) or ./dist/*.whl (this file). pyproject.toml is in 01_M0 T0.3.
artifacts:
  frostsight:
    type: whl
    path: .
    build: uv build --wheel

targets:
  personal:
    default: true                     # a bare `bundle deploy` goes to your own workspace, never to the team's
    mode: development                 # names get the prefix "[dev <you>] ", schedules are paused
    workspace:
      profile: frostsight-personal
    variables:
      schedule_pause_status: PAUSED
      pipeline_continuous: false
      pipeline_development: true

  free:
    mode: development
    workspace:
      profile: frostsight-free
    presets:
      name_prefix: ""                 # stable resource names on the team workspace
      trigger_pause_status: UNPAUSED  # development mode pauses schedules by default; the team job must run
    variables:
      schedule_pause_status: UNPAUSED
      pipeline_continuous: false
      pipeline_development: true

  aws:
    mode: development
    workspace:
      profile: frostsight-aws
    presets:
      name_prefix: ""
      trigger_pause_status: UNPAUSED
      pipelines_development: false    # development mode would force development: true on the pipeline; verify: preset name
    variables:
      schedule_pause_status: UNPAUSED
      pipeline_continuous: false      # flip to true for a continuous-stream test; costs per hour
      pipeline_development: false
    resources:
      jobs:
        collector:                    # exists only on aws (open egress); see T2.5 step 5
          name: frostsight-collector
          max_concurrent_runs: 1
          timeout_seconds: 540
          schedule:
            quartz_cron_expression: "0 0/10 * * * ?"
            timezone_id: UTC
            pause_status: ${var.schedule_pause_status}
          email_notifications:
            on_failure: [ "${var.notification_email}" ]
            no_alert_for_skipped_runs: true
          environments:
            - environment_key: collector
              spec:
                client: "4"
                dependencies:
                  - ./dist/*.whl      # paths in databricks.yml are relative to the bundle root
          tasks:
            - task_key: pull_datex
              environment_key: collector
              spark_python_task:
                python_file: ./collector/run.py
                parameters: ["--source", "road_weather", "road_incidents", "--target", "workspace"]
```

   Three things to know about this file:
   - `mode: development` on all three targets. It tags resources `dev`, keeps deployment state under
     `/Workspace/Users/<deployer>/.bundle/frostsight/<target>`, and by default prefixes names with
     `[dev <short_name>]` and pauses schedules. `free` and `aws` undo the two defaults with `presets`
     (`name_prefix: ""`, `trigger_pause_status: UNPAUSED`); `personal` keeps them, so your own deploy is
     prefixed with your name and nothing runs unless you start it.
   - `warehouse_id` is a `lookup` variable: the CLI resolves the id from the name at validate and deploy
     time, which is why `validate` needs credentials. verify: that a `lookup` value may reference
     `${var.warehouse_name}`; if the CLI rejects the substitution, write the literal name in the lookup and
     override `warehouse_id` per target instead (`databricks bundle validate -t free --strict` tells you).
   - The collector job is declared inline under `targets.aws.resources.jobs`, not in `resources/`: a file
     under `include` applies to every target and there is no "only on target X" switch inside a resource
     file. `bundle summary -t free` lists no collector job; `-t aws` does. Leave a one-line
     `resources/README.md` saying so.

2. Create the resource files. M4 to M6 fill in the code they point at and extend the jobs; the shape is final
   now and `05_M4` T4.7 shows the same three files with the M4 additions.

`resources/ingest.pipeline.yml` (the one Lakeflow Declarative Pipeline; Free Edition allows one active
pipeline per account, so bronze, silver, quarantine and the lookup all live here):

```yaml
resources:
  pipelines:
    ingest:
      name: frostsight-ingest
      catalog: ${var.catalog}
      schema: bronze                      # default schema; silver and quarantine tables use three-part names
      serverless: true
      continuous: ${var.pipeline_continuous}
      development: ${var.pipeline_development}
      channel: CURRENT
      root_path: ../src                   # puts src/ on the import path so `import frostsight` resolves (verify at M4)
      libraries:
        - glob:
            include: ../src/pipelines/**
      configuration:
        frostsight.catalog: ${var.catalog}
        frostsight.landing_root: ${var.landing_root}
        frostsight.config_dir: ${var.config_dir}
        frostsight.pilot_county: ${var.pilot_county}
        spark.sql.session.timeZone: UTC
      environment:
        dependencies:
          - pyyaml>=6
      event_log:                          # published event-log table; M4 and M6 query it (verify: key accepted by `bundle schema`)
        catalog: ${var.catalog}
        schema: gold
        name: ingest_event_log
      notifications:
        - email_recipients: [ "${var.notification_email}" ]
          alerts: [ on-update-failure, on-update-fatal-failure, on-flow-failure ]
      permissions:
        - level: CAN_VIEW                 # pipeline levels: CAN_VIEW, CAN_RUN, CAN_MANAGE
          group_name: users
```

`resources/orchestrate.job.yml` (version 1: pipeline update only; M5 adds gold and freshness after it,
serially, because of the 5-concurrent-task limit):

```yaml
resources:
  jobs:
    orchestrate:
      name: frostsight-orchestrate
      max_concurrent_runs: 1              # a slow update never overlaps the next one
      timeout_seconds: 1200
      schedule:
        quartz_cron_expression: "0 0/10 * * * ?"
        timezone_id: UTC
        pause_status: ${var.schedule_pause_status}
      email_notifications:
        on_failure: [ "${var.notification_email}" ]
        no_alert_for_skipped_runs: true
      tasks:
        - task_key: pipeline_update
          pipeline_task:
            pipeline_id: ${resources.pipelines.ingest.id}
            full_refresh: false
      permissions:
        - level: CAN_MANAGE_RUN           # job levels: CAN_VIEW, CAN_MANAGE_RUN, CAN_MANAGE
          group_name: users
```

`resources/reference.job.yml` (weekly batch loads; the task proves the wheel and the environment now):

```yaml
resources:
  jobs:
    reference:
      name: frostsight-reference
      max_concurrent_runs: 1
      timeout_seconds: 3600
      schedule:
        quartz_cron_expression: "0 0 3 ? * MON"     # weekly, Monday 03:00 UTC
        timezone_id: UTC
        pause_status: ${var.schedule_pause_status}
      email_notifications:
        on_failure: [ "${var.notification_email}" ]
      environments:
        - environment_key: geo
          spec:
            client: "4"
            dependencies:
              - ../dist/*.whl           # the frostsight package built by `artifacts`
              - pyproj>=3.6
              - shapely>=2
              - h3>=4
      tasks:
        - task_key: load_reference
          environment_key: geo
          spark_python_task:
            python_file: ../src/jobs/load_reference.py
            parameters: [ "--catalog", "${var.catalog}", "--landing", "${var.landing_root}" ]
```

`resources/dashboards.dashboard.yml` arrives at M6 (`07_M6`). For the record now: dashboards deploy with
`file_path`, `warehouse_id: ${var.warehouse_id}`, `dataset_catalog: ${var.catalog}`, `dataset_schema: gold`
(CLI 0.281.0 or newer) and `permissions: [{level: CAN_READ, group_name: users}]`; dashboard levels are
`CAN_READ`, `CAN_RUN`, `CAN_EDIT`, `CAN_MANAGE` (`CAN_VIEW` is a job and pipeline level and is rejected on a
dashboard).

3. Placeholder code so the bundle has something to sync and run. `src/frostsight/__init__.py` from T2.3.
   `src/pipelines/bronze.py` (replaced at M4; the placeholder table lets an update succeed, which the gate
   uses to measure the one-pipeline quota):

```python
"""M2 placeholder. Replaced by the Auto Loader tables at M4; drop frostsight.bronze.placeholder then."""
from pyspark import pipelines as dp


@dp.materialized_view(name="placeholder", comment="M2 bundle smoke test; removed at M4")
def placeholder():
    return spark.range(1).selectExpr("id", "current_timestamp() AS deployed_at")
```

   `src/jobs/load_reference.py` (replaced at M4; this version proves the wheel import):

```python
"""M2 placeholder: proves the wheel is installed in the job environment. Replaced at M4."""
import argparse

import frostsight

p = argparse.ArgumentParser()
p.add_argument("--catalog", required=True)
p.add_argument("--landing", required=True)
a = p.parse_args()
print(f"frostsight {frostsight.__version__}: catalog={a.catalog} landing={a.landing}")
```

4. Validate, deploy, inspect, run. Personal first, then the team workspace:

```bash
cd project
databricks bundle validate -t personal --strict
databricks bundle deploy   -t personal
databricks bundle run reference -t personal      # runs the placeholder; proves the wheel and the environment
databricks bundle run ingest    -t personal      # one pipeline update on the placeholder table
databricks bundle validate -t free --strict
databricks bundle validate -t aws  --strict      # profile frostsight-aws must exist even if unused; validate only
databricks bundle deploy   -t free               # only the admin identity does this; CI takes over in T2.4
databricks bundle summary  -t free
```

Expect, from `validate -t free --strict`:

```
Name: frostsight
Target: free
Workspace:
  Host: https://dbc-....cloud.databricks.com
  User: <admin email>
  Path: /Workspace/Users/<admin email>/.bundle/frostsight/free

Validation OK!
```

With `--strict`, any warning (an unknown key, an unresolved variable, a lookup that matched nothing) is an
error, so a clean run means every key above is accepted by this CLI version. From `deploy`: `Building
frostsight...`, `Uploading frostsight-0.1.0-py3-none-any.whl...`, `Uploading bundle files to
/Workspace/Users/.../files...`, `Deploying resources...`, `Deployment complete!`. From `summary -t free`: a
tree with `Jobs: orchestrate frostsight-orchestrate`, `reference frostsight-reference`, `Pipelines: ingest
frostsight-ingest`, each with a URL, and no `[dev ...]` prefix (on `personal` the prefix is there). From
`run reference`: `Run URL: ...` then `Run status: SUCCESS` and the print line in the task output. From
`run ingest`: an update that completes with `frostsight.bronze.placeholder` created.

Why deploys do not collide: state lives under `/Workspace/Users/<deployer>/.bundle/frostsight/<target>`, so
Sani's `personal` deploy and the CI deploy of `free` are two separate sets of objects even with the same
YAML. On `free` there is exactly one deployer (CI with the admin token, or the admin's laptop); on
`personal` each engineer is alone in their own workspace and metastore. If a second person deploys `free`,
the second pipeline tries to own the same tables and fails: rule, only the admin identity deploys `free`.

If it fails:
- `variable warehouse_id: lookup ... not found`: the warehouse name differs. `databricks warehouses list
  --profile frostsight-free`, then set `warehouse_name`.
- `Error: cannot resolve ${var.pipeline_continuous}` or a type error on `continuous`: the CLI version does
  not coerce a boolean variable into a boolean field. verify: `databricks -v` (use 1.0.0 or later);
  fallback is a literal `continuous:` override under `targets.<name>.resources.pipelines.ingest`.
- `artifact build failed`: `uv` is not on PATH, or `pyproject.toml` is missing from the repo root (T0.3).
- Deploy says the pipeline name already exists: someone else deployed `free`. See the rule above.
- `presets: unknown field pipelines_development`: drop that line on `aws` and set
  `development: ${var.pipeline_development}` explicitly under `targets.aws.resources.pipelines.ingest`.

---

### T2.3 Python package scaffolding      owner: Rayhan
Why: pipelines and jobs import pure functions from `frostsight`; unit tests import the same code locally.
The project file is the one from `01_M0` T0.3 (`pyproject.toml`, hatchling, packages
`src/frostsight` and `collector`); do not create another.

Do:
1. `src/frostsight/__init__.py`: `__version__ = "0.1.0"`. Add `src/frostsight/config.py` with one function
   `load_yaml(name: str, explicit_dir: str | None = None) -> dict` that reads `config/<name>` from
   `FROSTSIGHT_CONFIG_DIR`, the explicit argument, or the repo layout (`05_M4` T4.1 has the final version;
   start from it). `collector/__init__.py` exists from M1.
2. Build locally once: `uv build --wheel` from the repo root writes `dist/frostsight-0.1.0-py3-none-any.whl`.
   `dist/` is already ignored by the root `.gitignore`. The bundle rebuilds it on every deploy (`artifacts`
   block in T2.2).

Two ways to run job code, and the one we use:

| Option | How | Pros | Cons |
|---|---|---|---|
| A. Wheel in the serverless environment (chosen) | `artifacts` builds the wheel; each job lists `environments[].spec.dependencies: ../dist/*.whl`; tasks are `spark_python_task` scripts that `import frostsight` | Same import path locally and in the job; `pip` resolves `pyyaml` and `requests`; the collector reuses it on `aws` | One more build step; wheel version bump on release |
| B. Plain files synced by the bundle | `spark_python_task` with `source: WORKSPACE`; script does `sys.path.insert(0, "/Workspace/.../files/src")` | No build | Path hacks that differ per target; third-party dependencies still need an environment |

We use A for jobs. Pipelines are different: a serverless pipeline does not install the bundle wheel; it gets
`root_path: ../src` (so `src/` is importable and `from frostsight.transforms import ...` works inside
`src/pipelines/*.py`) plus `environment.dependencies` for third-party packages. verify at M4: if
`import frostsight` fails inside the pipeline, `05_M4` T4.7 step 2 has the alternative (`--editable
${workspace.file_path}` under `environment.dependencies`).

Expect: `uv build --wheel` prints `Successfully built dist/frostsight-0.1.0-py3-none-any.whl`;
`databricks bundle run reference -t personal` prints `frostsight 0.1.0: catalog=frostsight landing=...`.

If it fails: `ModuleNotFoundError: frostsight` in the job means the task has no `environment_key`, or the
`dependencies` path is wrong (`../dist/*.whl` in `resources/*.yml`, `./dist/*.whl` in `databricks.yml`).

---

### T2.4 CI and deploy workflows      owner: Rayhan
Why: every pull request gets lint, unit tests and `bundle validate`; `main` deploys to `free`; `aws` deploys
by hand once the service principal exists at M4.

Do:
1. Deploy identity on Free Edition. There are no service principals, so CI uses a personal access token
   of the team admin. Create one:

```bash
databricks tokens create --lifetime-seconds 7776000 --comment "github-actions frostsight" --profile frostsight-free
```

   Expect a JSON with `token_value`. Store it as the GitHub repository secret `DATABRICKS_TOKEN` and the
   workspace URL as `DATABRICKS_HOST` (Settings, Secrets and variables, Actions). Rotate before it expires
   (90 days above). If the command returns `FEATURE_DISABLED` or a 403, PATs are off on this workspace:
   then CI runs lint and tests only, `validate` is skipped in CI (it needs auth for the warehouse lookup and
   the current user), deploys happen from the admin's laptop with OAuth (`databricks auth login`), and the
   M2 gate records it.
2. `.github/workflows/ci.yml`. Everything runs inside the repo root, which has its own `pyproject.toml` and
   `uv.lock` (T0.3); the repo-root project is not touched:

```yaml
name: ci
on:
  pull_request:
    branches: [main]
defaults:
  run:
    working-directory: project
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "17" }     # local pyspark for the unit tests
      - uses: astral-sh/setup-uv@v5
        with:
          python-version: "3.12"
      - run: uv sync --frozen
      - run: uv run ruff check .
      - run: uv run pytest -q
      - uses: databricks/setup-cli@main
      - name: Build wheel and validate bundle
        env:
          DATABRICKS_HOST: ${{ secrets.DATABRICKS_HOST }}
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN }}
        run: |
          uv build --wheel
          databricks bundle validate -t free --strict
```

   `validate` needs credentials because `mode: development` resolves the current user and the `lookup`
   variable resolves the warehouse id. Alternative install without the action:
   `curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh`.
3. `.github/workflows/deploy-free.yml`:

```yaml
name: deploy-free
on:
  push:
    branches: [main]
concurrency: deploy-free
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
        with:
          python-version: "3.12"
      - uses: databricks/setup-cli@main
      - name: Deploy bundle to the team workspace
        working-directory: project
        env:
          DATABRICKS_HOST: ${{ secrets.DATABRICKS_HOST }}
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN }}
        run: databricks bundle deploy -t free --auto-approve
```

   Note: the `free` target names `workspace.profile: frostsight-free`; in CI there is no profile file, and
   the `DATABRICKS_HOST`/`DATABRICKS_TOKEN` environment variables take precedence. verify: the first CI run
   logs `User: <admin email>`. If the CLI insists on the profile, replace `profile:` with `host:` in the
   `free` target (`workspace.host: https://dbc-....cloud.databricks.com`) and keep the profile on your laptop
   through `DATABRICKS_CONFIG_PROFILE=frostsight-free`.
4. `.github/workflows/deploy-aws.yml` (file only at M2; secrets arrive at M4 with the trial workspace):

```yaml
name: deploy-aws
on:
  workflow_dispatch:
    inputs:
      confirm:
        description: Type "aws" to deploy to the AWS workspace
        required: true
jobs:
  deploy:
    if: ${{ github.event.inputs.confirm == 'aws' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
        with:
          python-version: "3.12"
      - uses: databricks/setup-cli@main
      - name: Deploy bundle to AWS as the service principal
        working-directory: project
        env:
          DATABRICKS_HOST: ${{ secrets.AWS_DATABRICKS_HOST }}
          DATABRICKS_CLIENT_ID: ${{ secrets.DATABRICKS_CLIENT_ID }}
          DATABRICKS_CLIENT_SECRET: ${{ secrets.DATABRICKS_CLIENT_SECRET }}
        run: |
          databricks bundle validate -t aws --strict
          databricks bundle deploy   -t aws --auto-approve
```

5. Add `tests/unit/test_placeholder.py` with one passing test so `pytest` has something to run
   (M1's `test_collector.py` may already exist; then skip this).

Expect: a PR shows the `ci` check green; merging to `main` shows `deploy-free` green and
`databricks bundle summary -t free` from the admin's laptop shows the same job ids as before (the bundle
state is keyed by the deploying user and target, so laptop and CI deploys of the admin identity update the
same objects).

If it fails:
- `Error: default auth: cannot configure default credentials`: the secrets are not set on the repository,
  or the workflow runs from a fork (forks do not get secrets).
- `uv sync --frozen` fails: `uv.lock` is stale; run `uv lock` locally and commit it.
- `deploy-free` runs but nothing changes: the deploying identity differs from the laptop identity, so it
  created a second set of objects. Use the admin token everywhere for `free`.

---

### T2.5 Collector deployment      owner: Shawon
Why: Free Edition jobs cannot reach DATEX, NVDB or Frost. The collector from M1 runs outside and lands files.

Do:
1. `.github/workflows/collector.yml`, every 30 minutes. GitHub schedules can lag a few minutes; the DATEX
   snapshot is a full state each pull, so lag only delays, it does not lose data:

```yaml
name: collector
on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:
concurrency:
  group: collector
  cancel-in-progress: false
jobs:
  collect:
    runs-on: ubuntu-latest
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
        with:
          python-version: "3.12"
      - run: uv sync --frozen --no-group dev --extra collector
        working-directory: project
      - name: Pull road weather and incidents, upload to the landing volume
        working-directory: project
        env:
          DATEX_USER: ${{ secrets.DATEX_USER }}
          DATEX_PASSWORD: ${{ secrets.DATEX_PASSWORD }}
          FROST_CLIENT_ID: ${{ secrets.FROST_CLIENT_ID }}
          DATABRICKS_HOST: ${{ secrets.DATABRICKS_HOST }}
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN }}
          DATABRICKS_CONFIG_PROFILE: ""
        run: uv run python -m collector.run --source road_weather road_incidents --target free
```

   `--target free` picks the `frostsight-free` profile in `collector.common`; on a runner there is no
   profile file, so `WorkspaceClient(profile=...)` must fall back to the `DATABRICKS_HOST`/`DATABRICKS_TOKEN`
   environment. verify on the first run: if the SDK errors with "profile not found", add
   `FROSTSIGHT_NO_PROFILE=1` handling in `common.upload` (`WorkspaceClient()` when the variable is set).
   Budget: a private repo has 2,000 free Actions minutes per month. 48 runs per day of about 1 minute is
   roughly 1,450 minutes per month, which leaves little for CI. Options in order: make the repo public
   (unlimited minutes, the code has no secrets in it), poll at 30 minutes and accept it, or move to the
   static-IP host below. Do not go to 10 minutes on Actions.
2. Static-IP alternative, needed if Statens vegvesen enforces the fixed-IP field of the DATEX form (M0
   answer). A small VM (about 5 USD per month) or a Cefalo server. Install `uv`, clone the repo, run
   `databricks auth login --host <team url> --profile frostsight-free` once as the collector user (or put
   `DATABRICKS_HOST`/`DATABRICKS_TOKEN` in the env file), put the source secrets in
   `/etc/frostsight/collector.env` (mode 600), then two systemd units:

```ini
# /etc/systemd/system/frostsight-collector.service
[Unit]
Description=FrostSight collector: DATEX road weather and incidents to the landing volume
After=network-online.target

[Service]
Type=oneshot
User=frostsight
WorkingDirectory=/opt/frostsight
EnvironmentFile=/etc/frostsight/collector.env
ExecStart=/usr/local/bin/uv run python -m collector.run --source road_weather road_incidents --target free
```

```ini
# /etc/systemd/system/frostsight-collector.timer
[Unit]
Description=Run the FrostSight collector every 10 minutes

[Timer]
OnCalendar=*:0/10
RandomizedDelaySec=20
Persistent=true

[Install]
WantedBy=timers.target
```

   `sudo systemctl enable --now frostsight-collector.timer`; check with `systemctl list-timers` and
   `journalctl -u frostsight-collector -n 50`. A 10-minute cadence matches the source here because there
   is no minutes budget.
3. NVDB is reference data and runs weekly: a second Actions workflow `collector-nvdb.yml` with
   `cron: "0 3 * * 1"` running `--source nvdb datex_sites metadata --county 55`, or the same systemd timer
   with `OnCalendar=Mon 03:00`. The `reference` job (T2.2) runs at 03:00 UTC too; schedule the collector at
   02:00 so the files are there first.
4. Watch the first hour: `databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_weather/$(date -u +%Y/%m/%d)/ --profile frostsight-free`
   should grow by one `.jsonl` per run, and `road_weather_xml/` by one `.xml`.
5. Switching to the workspace on the `aws` target later. The collector job is defined under
   `targets.aws.resources.jobs` (T2.2). It runs the same `collector/run.py` from the wheel with
   `--target workspace`, which makes `collector.common.deliver` copy files straight to `/Volumes/...` with
   normal file IO instead of the Files API, and makes `run.py` read the source credentials from the
   `frostsight` secret scope (`databricks secrets create-scope frostsight --profile frostsight-aws`, then
   `put-secret` as in `01_M0` T0.4). Then pause the Actions cron (`workflow_dispatch` only) so two collectors
   do not write the same minute. The DATEX fixed-IP question applies to the workspace too: serverless egress
   has no fixed IP, so if it is enforced the static-IP host stays even on `aws`.

Expect: after one hour, six files (30-minute cadence: two) under `road_weather/<today>/` and the same under
`road_incidents/`, plus the XML twins; each `.jsonl` 50 KB to 300 KB; the Actions run summary shows
`uploaded /Volumes/frostsight/landing/raw/road_weather/.../....jsonl`.

If it fails:
- 401 from DATEX: wrong secret name, or the account is IP-locked (the Actions runner IP changes each run).
- `databricks-sdk` upload 403: the token owner lacks `WRITE VOLUME` (T1.1 grants).
- `parsed zero records` from `datex.py`: the element names need the T1.5 step 3 check; the raw XML is
  landed anyway.
- No run at the expected minute: scheduled workflows on a repo with no recent commits are throttled by
  GitHub after 60 days of inactivity; `workflow_dispatch` once re-enables them.

---

### T2.6 Replay harness prototype      owner: Sani
Why: the demo, the streaming tests (M4 T4.8: duplicate file, late file) and S1 use last winter's data. The
harness turns `frost_history` lines into the same 10-minute `road_weather` files the collector writes
(contract v1), in event-time order, faster than real time, so the live pipeline processes them unchanged.

Do:
1. `config/replay_events.yml` comes from M1 T1.8 (ids, `start`, `end`, `label`, `why`). The harness finds
   the history files by date (`frost_history/<yyyy>/<mm>/01/<month start>_<SN>.jsonl`, M1 layout), so the
   file holds no paths or globs.

2. `replay/__init__.py` (empty) and `replay/harness.py`. Input: `frost_history` lines
   (`station_id`, `frost_source_id`, `event_time` UTC ISO, the measured fields) or, with `--latest`, the
   newest live `road_weather` file. Output: one file per 10-minute bucket at
   `raw/road_weather/<yyyy>/<mm>/<dd>/replay__<event_id>__<ts>__r<UTC run start>.jsonl` in contract v1. Bronze
   derives `_batch_id = replay:<event_id>` from part 2 of the file name (README section 4; `05_M4`
   `batch_id_from_path`), so the rows carry no `_batch_id` field and no sidecar file is needed. The run suffix
   (`--run`, default `r<UTC start of this run>`) gives every run new paths: Auto Loader never re-reads a path it
   has already ingested, so a second run of the same event with the same names would be skipped (10_S1 D3).

```python
"""Replay Frost history (or re-emit a live file) into the landing volume as 10-minute road_weather files
in contract v1, named replay__<event_id>__<ts>__<run>.jsonl, at N x real time.

Usage:
  python -m replay.harness --event storm_2026_01_15 --speed 60 --target free           # a storm, one file every 10 s
  python -m replay.harness --from 2026-01-15 --to 2026-01-16 --speed 0 --target free   # one day, no pauses (backfill)
  python -m replay.harness --latest --shift 0    --target personal                     # duplicate of the newest live file
  python -m replay.harness --latest --shift -25  --target personal                     # same readings, 25 min late (inside the watermark)
  python -m replay.harness --latest --shift -125 --target personal                     # 125 min late (beyond the 30-min watermark)

--shift moves every measurement_time by N minutes. Use a value that is not a multiple of 10 for the
late-file test: a multiple of 10 lands on existing (station, time) keys and is deduplicated, which is the
duplicate test, not the late test.

Every file this harness writes is a replay file (_batch_id = replay:...), so silver sends it through the
replay flow, which has its own watermark and dedup state (05_M4 T4.4). A --latest file is therefore NOT
deduplicated against the live rows it copies and is not late relative to the live watermark: it tests the
replay flow. The live duplicate and late-file tests are the hand-made live-named files of 05_M4 T4.8 steps
4 and 5. Use --latest on personal only and delete its rows afterwards (_batch_id LIKE 'replay:latest_%').
"""
from __future__ import annotations

import argparse
import io
import json
import time
from collections import defaultdict
from collections.abc import Iterable, Iterator
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import yaml
from databricks.sdk import WorkspaceClient
from databricks.sdk.errors import NotFound

BUCKET = timedelta(minutes=10)
CONFIG = Path(__file__).resolve().parents[1] / "config" / "replay_events.yml"
VOLUME = "/Volumes/frostsight/landing/raw"
PROFILES = {"free": "frostsight-free", "personal": "frostsight-personal", "aws": "frostsight-aws"}
TS = "%Y-%m-%dT%H:%M:%SZ"


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def floor_to_bucket(ts: datetime) -> datetime:
    return ts - timedelta(minutes=ts.minute % 10, seconds=ts.second, microseconds=ts.microsecond)


def load_event(event_id: str) -> dict:
    events = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))["events"]
    match = [e for e in events if e["id"] == event_id]
    if not match:
        raise SystemExit(f"unknown event {event_id}; known: {[e['id'] for e in events]}")
    return match[0]


def month_starts(start: datetime, end: datetime) -> Iterator[date]:
    cur = date(start.year, start.month, 1)
    while cur < end.date():
        yield cur
        cur = date(cur.year + (cur.month == 12), (cur.month % 12) + 1, 1)


def list_files(w: WorkspaceClient, folder: str) -> list[str]:
    try:
        return sorted(e.path for e in w.files.list_directory_contents(folder) if not e.is_directory)
    except NotFound:
        return []


def download_lines(w: WorkspaceClient, path: str) -> list[dict]:
    body = w.files.download(path).contents.read().decode("utf-8")
    return [json.loads(line) for line in body.splitlines() if line.strip()]


def read_history(w: WorkspaceClient, start: datetime, end: datetime) -> list[dict]:
    """frost_history files sit under <yyyy>/<mm>/01/ (month start); rows without a station_id are skipped."""
    rows: list[dict] = []
    for m in month_starts(start, end):
        for path in list_files(w, f"{VOLUME}/frost_history/{m:%Y/%m/%d}"):
            rows.extend(r for r in download_lines(w, path)
                        if r.get("station_id") and start <= parse_ts(r["event_time"]) < end)
    return rows


def read_latest_live(w: WorkspaceClient) -> list[dict]:
    """The newest live road_weather file (replay files excluded), for the duplicate and late-file tests."""
    now = datetime.now(timezone.utc)
    for day in (now, now - timedelta(days=1)):
        files = [p for p in list_files(w, f"{VOLUME}/road_weather/{day:%Y/%m/%d}") if "replay__" not in p]
        if files:
            return download_lines(w, files[-1])
    raise SystemExit("no live road_weather file in the last two days")


def precip_type(mm_10min: float | None, air: float | None) -> str:
    """Frost has no precipitation type; approximate it from amount and air temperature (documented in the ADR)."""
    if mm_10min is None:
        return "unknown"
    if mm_10min <= 0:
        return "none"
    if air is None:
        return "unknown"
    return "snow" if air <= 0.5 else "sleet" if air <= 2.0 else "rain"


def to_contract(row: dict) -> dict:
    """frost_history line -> contract v1 line. Live lines already are contract v1 and pass through."""
    if "measurement_time" in row:
        return dict(row)
    return {
        "schema_version": "1",
        "source_event_id": f"FROST-{row['frost_source_id']}-{row['event_time']}",
        "station_ref": row["station_id"], "site_id": row["frost_source_id"], "measurement_time": row["event_time"],
        "air_temperature": row.get("air_temperature"), "road_surface_temperature": row.get("road_surface_temperature"),
        "dew_point": row.get("dew_point"), "humidity": row.get("humidity"), "temperature_unit": "C",
        "precipitation_type": precip_type(row.get("precipitation_10min"), row.get("air_temperature")),
        "precipitation_intensity": row.get("precipitation_10min"), "precipitation_unit": "mm/10min",
        "wind_speed": row.get("wind_speed"), "wind_speed_unit": "m/s", "wind_direction": row.get("wind_direction"),
        "road_surface_state": None,
    }


def shift(row: dict, minutes: int) -> dict:
    if minutes:
        row["measurement_time"] = (parse_ts(row["measurement_time"]) + timedelta(minutes=minutes)).strftime(TS)
        row["source_event_id"] = f"{row['source_event_id']}{minutes:+d}m"
    return row


def bucketize(rows: Iterable[dict]) -> list[tuple[datetime, list[dict]]]:
    buckets: dict[datetime, list[dict]] = defaultdict(list)
    for row in rows:
        buckets[floor_to_bucket(parse_ts(row["measurement_time"]))].append(row)
    return sorted(buckets.items())


def landing_path(bucket: datetime, event_id: str, run: str) -> str:
    """05_M4 batch_id_from_path takes part [1] (the event id); the run suffix only makes the path new."""
    return (f"{VOLUME}/road_weather/{bucket:%Y/%m/%d}/"
            f"replay__{event_id}__{bucket:%Y%m%dT%H%M%SZ}__{run}.jsonl")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--event", help="event id from config/replay_events.yml")
    src.add_argument("--from", dest="date_from", type=date.fromisoformat, help="inclusive day; needs --to")
    src.add_argument("--latest", action="store_true", help="re-emit the newest live road_weather file")
    ap.add_argument("--to", dest="date_to", type=date.fromisoformat, help="exclusive day")
    ap.add_argument("--speed", type=float, default=60.0, help="60 = one 10-minute file every 10 s; 0 = no pause")
    ap.add_argument("--shift", type=int, default=0, help="minutes added to every measurement_time; negative = late")
    ap.add_argument("--target", choices=sorted(PROFILES), default="free", help="bundle target name; picks the CLI profile")
    ap.add_argument("--run", default=None, help="run suffix; default r<UTC start>, e.g. r20261120T091500Z")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    run = args.run or datetime.now(timezone.utc).strftime("r%Y%m%dT%H%M%SZ")
    if "__" in run:
        raise SystemExit("--run must not contain '__'")
    if "__" in (args.event or ""):
        raise SystemExit("event ids must not contain '__'; it separates the parts of the file name")

    w = WorkspaceClient(profile=PROFILES[args.target])
    if args.event:
        event = load_event(args.event)
        event_id, rows = event["id"], read_history(w, parse_ts(event["start"]), parse_ts(event["end"]))
    elif args.date_from:
        if not args.date_to:
            raise SystemExit("--from needs --to")
        start = datetime.combine(args.date_from, datetime.min.time(), tzinfo=timezone.utc)
        end = datetime.combine(args.date_to, datetime.min.time(), tzinfo=timezone.utc)
        event_id, rows = f"backfill_{args.date_from:%Y%m%d}", read_history(w, start, end)
    else:
        event_id, rows = f"latest_{'m' if args.shift < 0 else 'p'}{abs(args.shift)}", read_latest_live(w)

    buckets = bucketize(shift(to_contract(r), args.shift) for r in rows)
    print(f"{len(rows)} rows -> {len(buckets)} files, event {event_id}, shift {args.shift} min, speed {args.speed}x")

    pause_s = BUCKET.total_seconds() / args.speed if args.speed > 0 else 0.0
    for bucket, records in buckets:
        path = landing_path(bucket, event_id, run)
        payload = "\n".join(json.dumps(r, separators=(",", ":")) for r in records) + "\n"
        if args.dry_run:
            print(f"would write {path} ({len(records)} rows)")
        else:
            w.files.upload(path, io.BytesIO(payload.encode("utf-8")), overwrite=True)
            print(f"{datetime.now(timezone.utc):%H:%M:%S} wrote {path} ({len(records)} rows)")
        if pause_s:
            time.sleep(pause_s)
    print(f"run {run}: {len(buckets)} files for event {event_id}")


if __name__ == "__main__":
    main()
```

3. Prototype run against your personal workspace, then a dry run against the team workspace. The event id
   below is whatever M1 wrote into `replay_events.yml`:

```bash
cd project
uv run python -m replay.harness --event storm_2026_01_15 --speed 600 --target personal
uv run python -m replay.harness --event storm_2026_01_15 --speed 60 --target free --dry-run
uv run python -m replay.harness --latest --shift 0 --target personal --dry-run       # needs one live file in your volume
```

4. Write down the rules the harness relies on, in `replay/README.md`: replay never runs while the live
   collector is writing into the same day folder (Free Edition, one pipeline; the S1 file has the slot
   procedure); replay files are removed with `databricks fs rm -r` on the replay day folder after a demo,
   or live and replay rows are separated by `_batch_id LIKE 'replay:%'` (the M7 diff query); the
   precipitation type of Frost rows is an approximation (`precip_type`) and says so in ADR 0007.

Expect: `--dry-run` prints `N rows -> 72 files` for a 12-hour window (144 for a full day); a real run at
600x takes about 72 seconds and `databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_weather/2026/01/15/ --profile frostsight-personal`
lists `replay__storm_2026_01_15__20260115T000000Z__r<run start>.jsonl` upwards; every line has `station_ref`,
`measurement_time`, `precipitation_unit: "mm/10min"`.

If it fails:
- `0 rows`: `frost_history/<yyyy>/<mm>/01/` is empty for the event's months, or every line has a null
  `station_id` (M1 T1.4 matching); `databricks fs ls` the folder and check one file.
- `KeyError: event_time`: the M1 history schema uses another name; fix M1's `frost.py`, not the harness.
- Slow uploads: each `w.files.upload` is one HTTPS call; that is fine for 72 files, not for a full winter.
  For a season, run with `--speed 0` from a host near the workspace, or upload a day's folder with
  `databricks fs cp -r`.

---

### T2.7 DQ rule catalogue      owner: Rayhan
Why: M4 turns these rules into pipeline expectations and quarantine flows; M6 reports on them by name.
One file keeps names stable across code, quarantine rows and dashboards. The file shape is the one
`frostsight.config.rules_by_action` (05_M4 T4.1) reads: a list per dataset, each rule with `name`,
`condition`, `action`. `action` is `drop` (row goes to quarantine, not to silver; `expect_all_or_drop`),
`warn` (row passes, count logged; `expect_all`) or `fail` (pipeline update stops; `expect_or_fail`, none
in v1). Datasets not produced by the pipeline (`road_weather_stations`, `road_segments`) are checked by the
reference job with the same names.

Do: create `config/dq_rules.yml` from spec sections 10 and 11:

```yaml
# Row-level rules. action: drop = expect_or_drop (row goes to quarantine), warn = expect (row kept, counted).
# Column names are the silver contract (04_M3 T3.1). Names are unique per dataset and appear as-is in the
# pipeline event log, quarantine.rule and the health dashboard.
road_weather_observations:
  - name: station_known
    condition: "station_id IS NOT NULL"
    action: drop
  - name: event_time_valid
    condition: "event_time IS NOT NULL AND event_time > TIMESTAMP '2015-01-01' AND event_time < current_timestamp() + INTERVAL 1 HOUR"
    action: drop
  - name: air_temp_range
    condition: "air_temperature_c IS NULL OR air_temperature_c BETWEEN -60 AND 50"
    action: drop
  - name: surface_temp_range
    condition: "road_surface_temperature_c IS NULL OR road_surface_temperature_c BETWEEN -60 AND 80"
    action: drop
  - name: wind_non_negative
    condition: "wind_speed_ms IS NULL OR wind_speed_ms >= 0"
    action: drop
  - name: precip_non_negative
    condition: "precipitation_intensity_mm_h IS NULL OR precipitation_intensity_mm_h >= 0"
    action: drop
  - name: wind_plausible
    condition: "wind_speed_ms IS NULL OR wind_speed_ms <= 60"
    action: warn
  - name: precip_plausible
    condition: "precipitation_intensity_mm_h IS NULL OR precipitation_intensity_mm_h <= 50"
    action: warn
  - name: surface_temp_present
    condition: "road_surface_temperature_c IS NOT NULL"
    action: warn      # risk cannot be scored without it; counted, not dropped
road_incidents:
  - name: incident_id_present
    condition: "incident_id IS NOT NULL"
    action: drop
  - name: start_before_end
    condition: "end_time IS NULL OR start_time <= end_time"
    action: drop
  - name: type_known
    condition: "incident_type IN ('CLOSURE','ACCIDENT','ROADWORK','WEATHER','OBSTRUCTION','OTHER')"
    action: warn
  - name: in_norway
    condition: "lat IS NULL OR (lat BETWEEN 57 AND 72 AND lon BETWEEN 4 AND 32)"
    action: warn
# Checked by the reference job (04_M3 T3.1: job-written tables), same names, same actions.
road_weather_stations:
  - name: station_id_present
    condition: "station_id IS NOT NULL"
    action: drop
  - name: in_norway
    condition: "lat BETWEEN 57 AND 72 AND lon BETWEEN 4 AND 32"
    action: drop
road_segments:
  - name: geometry_present
    condition: "geometry_wkt_25833 IS NOT NULL AND length_m > 0"
    action: drop
  - name: elevation_plausible
    condition: "elevation_m IS NULL OR elevation_m BETWEEN -10 AND 2500"
    action: warn
```

Lateness is not a rule: an expectation runs after the watermark and dedup operator has already dropped a
row that is older than the watermark, so it can never see it. Late rows are counted at M6 by comparing
bronze and silver row counts per `_source_file` (04_M3 T3.2, D4). Station-to-segment coverage is not a
rule on observations either: the lookup is a materialized view and unmatched stations land in
`quarantine.unmapped_observations` (05_M4 T4.5).

Expect: `uv run python -c "import yaml; d=yaml.safe_load(open('config/dq_rules.yml')); print({k: len(v) for k, v in d.items()})"`
prints `{'road_weather_observations': 9, 'road_incidents': 4, 'road_weather_stations': 2, 'road_segments': 2}`.
Add a unit test that names are unique within each dataset and every `action` is in `{drop, warn, fail}`.

---

### T2.8 Freshness and DQ table design      owner: Rayhan
Why: M6 fills these; the health dashboard is written against the columns now. The columns are the ones
`07_M6` `build_freshness.py` and `data_quality_events.sql` write; change them there and here together.

`silver.data_quality_events` (append; one row per expectation per flow per pipeline update, extracted from
the pipeline event log):

| Column | Type | Meaning |
|---|---|---|
| event_time | TIMESTAMP | event-log timestamp of the flow progress record (UTC) |
| pipeline_run_id | STRING | `origin.update_id` of the pipeline update |
| flow_name | STRING | `origin.flow_name`, e.g. `road_weather_observations` |
| dataset | STRING | the expectation's dataset as the event log reports it |
| rule_id | STRING | rule `name` from `dq_rules.yml` |
| passed_records | BIGINT | |
| failed_records | BIGINT | |

`gold.data_quality_summary` (MERGE on `source`; one row per source), plus `gold.data_quality_summary_history`
with the same columns, appended every run for the sparkline:

| Column | Type | Meaning |
|---|---|---|
| source | STRING | `road_weather`, `incidents`, `nvdb`, `frost` |
| last_event_time | TIMESTAMP | max measurement time in silver |
| last_ingested_at | TIMESTAMP | max `_ingested_at` in bronze |
| lag_minutes | DOUBLE | now minus `last_event_time` |
| stale_threshold_minutes | INT | 30 for road weather, 60 for incidents, 8 days for NVDB; null = reference data, never stale |
| status | STRING | `Fresh`, `Stale`, `No data` |
| rows_last_hour | BIGINT | silver rows |
| quarantined_last_hour | BIGINT | quarantine rows for the source |
| computed_at | TIMESTAMP | |

Create the three tables now with `CREATE TABLE IF NOT EXISTS` in `sql/002_dq_tables.sql` (run
the same way as `001_...`), so M4 can already read `silver.data_quality_events` on the health page draft
and M6 finds the tables in place:

```sql
CREATE TABLE IF NOT EXISTS frostsight.silver.data_quality_events (
  event_time TIMESTAMP, pipeline_run_id STRING, flow_name STRING, dataset STRING,
  rule_id STRING, passed_records BIGINT, failed_records BIGINT);
CREATE TABLE IF NOT EXISTS frostsight.gold.data_quality_summary (
  source STRING, last_event_time TIMESTAMP, last_ingested_at TIMESTAMP, lag_minutes DOUBLE,
  stale_threshold_minutes INT, status STRING, rows_last_hour BIGINT, quarantined_last_hour BIGINT,
  computed_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS frostsight.gold.data_quality_summary_history
  LIKE frostsight.gold.data_quality_summary;
```

---

## M2 gate

Run this checklist in the weekly session. Safiul decides.

| # | Check | Command or evidence | Pass |
|---|---|---|---|
| 1 | Road-weather files landing every 10 to 30 min for 24 h | `databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_weather/<today>/ --profile frostsight-free` shows 48 to 144 `.jsonl` files | |
| 2 | Incident files landing for 24 h | same under `road_incidents/` | |
| 3 | NVDB extract present and re-runnable | `nvdb_road_network/`, `nvdb_stations/`, `nvdb_accidents/`, `nvdb_avalanche/` have a file for county 55; the weekly run succeeded once | |
| 4 | Files are readable as data | `SELECT count(*), count(DISTINCT station_ref) FROM read_files('/Volumes/frostsight/landing/raw/road_weather/', format => 'json')` returns rows and a few hundred stations | |
| 5 | Catalog, schemas, volume, grants | `SHOW GRANTS ON SCHEMA frostsight.silver` per user (T2.1) | |
| 6 | Bundle deploys to `free`, validates for `aws` | `databricks bundle summary -t free`; `validate -t aws --strict` | |
| 7 | CI green on a PR; `deploy-free` green on main | GitHub checks | |
| 8 | Replay harness dry run prints the expected file count | T2.6 step 3 | |
| 9 | Free Edition limits reviewed with real numbers | placeholder pipeline update time, quota hits, tasks queued, `RESOURCE_EXHAUSTED` seen or not | |

Fallback decision: if any of checks
1 to 3 fails because a source cannot be reached (DATEX account refused, fixed IP enforced with no host
available), the signal is to switch that source to a generator that writes the
same landing files from last winter's Frost history (the replay harness with `--from/--to` is that
generator). If check 9 shows the one-pipeline or five-task limit is costing real time, move only the team
workspace to the paid trial for M4 to M7 (Option B in `platform-targets.md`, about 150 USD).

## Done when

- [ ] `sql/001_catalog_schemas_volume.sql` confirmed on the team workspace and in every personal workspace (T2.1)
- [ ] `databricks.yml`, the three resource files, `src/frostsight/__init__.py`, `config.py` and the placeholders merged; `bundle validate -t free --strict` and `-t aws --strict` clean
- [ ] `ci.yml`, `deploy-free.yml`, `deploy-aws.yml`, `collector.yml` merged; PAT stored or the OAuth-laptop fallback recorded
- [ ] Collector running on a schedule; 24 hours of road-weather and incident files present (`.jsonl` and `.xml`)
- [ ] `replay/harness.py`, `config/dq_rules.yml`, `sql/002_dq_tables.sql` merged; `config/replay_events.yml` from M1 in place
- [ ] Gate checklist filled in; if the fallback is taken it is recorded in `docs/adr/0008-m2-fallback.md` (repo root), otherwise in the meeting notes

## Verify

```bash
cd project
databricks bundle validate -t free --strict && databricks bundle validate -t aws --strict
databricks bundle summary -t free
databricks jobs list --profile frostsight-free            # expect frostsight-orchestrate, frostsight-reference (no [dev] prefix)
databricks pipelines list-pipelines --profile frostsight-free   # verify: `list-pipelines` versus `list` in your CLI version
databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_weather/$(date -u +%Y/%m/%d)/ --profile frostsight-free
databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_incidents/$(date -u +%Y/%m/%d)/ --profile frostsight-free
databricks fs ls dbfs:/Volumes/frostsight/landing/raw/nvdb_road_network/ --profile frostsight-free
uv run python -m replay.harness --event <id from config/replay_events.yml> --speed 60 --target free --dry-run
```

```sql
SELECT count(DISTINCT _metadata.file_path) AS files, count(*) AS rows,
       min(_metadata.file_modification_time) AS first, max(_metadata.file_modification_time) AS last
FROM read_files('/Volumes/frostsight/landing/raw/road_weather/', format => 'json');
SHOW GRANTS ON VOLUME frostsight.landing.raw;
SELECT * FROM frostsight.bronze.placeholder;    -- the M2 pipeline smoke test table
```
