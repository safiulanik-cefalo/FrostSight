"""Publish a FrostSight dashboard: the demo on frostsight.mock, or the live one on frostsight.gold.

Demo (default):
1. Runs nvdb_seed.sql (real roads and stations) and mock_data.sql one statement at a time on a SQL warehouse
   (creates or replaces frostsight.mock).
Live (--dashboard live, docs/gold-from-team-silver.md):
1. With --load-reference, loads the roads, segments, road points and stations of nvdb_seed.sql into
   silver.nvdb_seed_* (the interim reference data, B3). Then creates the gold views
   (src/sql/002_gold_views.sql); the gold job (resources/gold.job.yml) must have run once, because it
   creates the gold tables.
Both:
2. Runs every dataset of the dashboard JSON against its schema and prints the row count, as the dashboard
   skill requires before a deploy.
3. Creates the dashboard (or updates the one recorded in .dashboard_id.<profile>[.live]) and publishes it.
   The live JSON's "Fetch now" link is set to the gold job's page in this workspace.
4. With --share GROUP, gives that workspace group CAN_RUN on the dashboard.

Personal workspace by default.

Run: uv run python tools/mock_dashboards/deploy.py [--profile NAME] [--warehouse-id ID] [--setup]
     [--dashboard demo|live] [--load-reference] [--share GROUP]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SEED_SQL = HERE / "nvdb_seed.sql"  # written by fetch_nvdb.py
MOCK_SQL = HERE / "mock_data.sql"
SETUP_SQL = REPO / "sql" / "001_catalog_schemas_volume.sql"
VIEWS_SQL = REPO / "src" / "sql" / "002_gold_views.sql"
CATALOG = "frostsight"
# variant: (dashboard JSON, schema, display name, state-file suffix)
VARIANTS = {
    "demo": (HERE / "frostsight_demo.lvdash.json", "mock", "FrostSight demo (mock data)", ""),
    "live": (HERE / "frostsight_live.lvdash.json", "gold", "FrostSight (live)", ".live"),
}
GOLD_JOB = "frostsight-gold"  # resources/gold.job.yml; development mode may prefix the name
REFERENCE_TABLES = ("roads", "road_points", "segments", "stations")
WAREHOUSE_NAME = "Serverless Starter Warehouse"  # databricks.yml default for warehouse_name


def cli(args: list[str], profile: str) -> Any:
    out = subprocess.run(
        ["databricks", *args, "--profile", profile, "-o", "json"], capture_output=True, text=True
    )
    if out.returncode != 0:
        raise RuntimeError(
            f"databricks {' '.join(args[:3])} failed: {out.stderr.strip() or out.stdout.strip()}"
        )
    return json.loads(out.stdout) if out.stdout.strip() else {}


def run_sql(statement: str, profile: str, warehouse_id: str, schema: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "statement": statement,
        "warehouse_id": warehouse_id,
        "wait_timeout": "50s",
        "on_wait_timeout": "CONTINUE",
        "catalog": CATALOG,
    }
    if schema:
        body["schema"] = schema
    res = cli(["api", "post", "/api/2.0/sql/statements", "--json", json.dumps(body)], profile)
    while res.get("status", {}).get("state") in ("PENDING", "RUNNING"):
        time.sleep(3)
        res = cli(["api", "get", f"/api/2.0/sql/statements/{res['statement_id']}"], profile)
    return res


def ok(res: dict[str, Any]) -> bool:
    return res.get("status", {}).get("state") == "SUCCEEDED"


def error(res: dict[str, Any]) -> str:
    return res.get("status", {}).get("error", {}).get("message", json.dumps(res.get("status")))[:600]


def statements(path: Path) -> list[str]:
    """Split a script on semicolons that end a line; drop chunks that hold only comments."""
    parts = re.split(r";\s*$", path.read_text(), flags=re.MULTILINE)
    keep = []
    for p in parts:
        code = "\n".join(line for line in p.splitlines() if not line.strip().startswith("--")).strip()
        if code:
            keep.append(p.strip())
    return keep


def pick_warehouse(profile: str, wanted: str | None) -> str:
    if wanted:
        return wanted
    warehouses = cli(["warehouses", "list"], profile)
    for w in warehouses:
        if w.get("name") == WAREHOUSE_NAME:
            return w["id"]
    if not warehouses:
        sys.exit("No SQL warehouse in this workspace.")
    print(f"'{WAREHOUSE_NAME}' not found; using '{warehouses[0]['name']}'")
    return warehouses[0]["id"]


def load_mock(profile: str, wh: str, setup: bool) -> None:
    if setup:
        for s in statements(SETUP_SQL):
            res = run_sql(s, profile, wh)
            if not ok(res):
                sys.exit(f"setup failed on:\n{s[:200]}\n{error(res)}")
        print("ran sql/001_catalog_schemas_volume.sql")
    elif not ok(run_sql(f"DESCRIBE CATALOG {CATALOG}", profile, wh)):
        sys.exit(
            f"Catalog {CATALOG} is missing: run sql/001_catalog_schemas_volume.sql once, or pass --setup."
        )

    spatial = ok(run_sql("SELECT ST_AsText(ST_GeomFromText('LINESTRING(0 0, 1 1)', 4326))", profile, wh))
    geometry = "ST_GeomFromText(geometry_wkt_4326, 4326)" if spatial else "CAST(NULL AS STRING)"
    print(f"spatial SQL on this warehouse: {'yes' if spatial else 'no, v_segments.geometry is NULL'}")

    if not SEED_SQL.exists():
        sys.exit("nvdb_seed.sql is missing: run tools/mock_dashboards/fetch_nvdb.py first.")
    for path in (SEED_SQL, MOCK_SQL):
        tmp = HERE / ".mock_data.resolved.sql"
        tmp.write_text(path.read_text().replace("{geometry_expr}", geometry))
        try:
            for i, s in enumerate(statements(tmp), 1):
                res = run_sql(s, profile, wh)
                if not ok(res):
                    sys.exit(f"{path.name} statement {i} failed:\n{s[:300]}\n{error(res)}")
        finally:
            tmp.unlink(missing_ok=True)
    print(f"loaded {CATALOG}.mock")


def run_script(path: Path, profile: str, wh: str, rewrite: Any = None) -> None:
    for i, s in enumerate(statements(path), 1):
        s = rewrite(s) if rewrite else s
        if s is None:
            continue
        res = run_sql(s, profile, wh)
        if not ok(res):
            sys.exit(f"{path.name} statement {i} failed:\n{s[:300]}\n{error(res)}")


def load_reference(profile: str, wh: str) -> None:
    """The real NVDB roads, segments, points and stations of nvdb_seed.sql into silver.nvdb_seed_* (B3)."""

    def to_silver(stmt: str) -> str | None:
        if "seed_incidents" in stmt or "CREATE SCHEMA" in stmt:  # mock incidents are not reference data
            return None
        return stmt.replace(f"{CATALOG}.mock.seed_", f"{CATALOG}.silver.nvdb_seed_")

    run_script(SEED_SQL, profile, wh, to_silver)
    for t in REFERENCE_TABLES:
        comment = (
            "Interim reference data: real NVDB data (NLOD) from tools/mock_dashboards/nvdb_seed.sql; "
            "replaced by the reference job (05_M4 T4.6). docs/gold-from-team-silver.md B3"
        )
        run_sql(f"COMMENT ON TABLE {CATALOG}.silver.nvdb_seed_{t} IS '{comment}'", profile, wh)
    print(f"loaded {CATALOG}.silver.nvdb_seed_{{{','.join(REFERENCE_TABLES)}}}")


def create_gold_views(profile: str, wh: str) -> None:
    if not ok(run_sql(f"DESCRIBE TABLE {CATALOG}.gold.road_weather_observation_log", profile, wh)):
        sys.exit("gold tables are missing: run the gold job once (databricks bundle run gold -t <target>).")
    run_script(VIEWS_SQL, profile, wh)
    print(f"created the gold views ({VIEWS_SQL.relative_to(REPO)})")


def fetch_url(profile: str, host: str) -> str:
    """The gold job's page: its "Run now" fetches the sources and rebuilds gold."""
    jobs = [j for j in cli(["jobs", "list"], profile) if j["settings"]["name"].endswith(GOLD_JOB)]
    if not jobs:
        sys.exit(
            f"job '{GOLD_JOB}' not found: deploy the bundle first (databricks bundle deploy -t <target>)."
        )
    return f"{host}/jobs/{jobs[0]['job_id']}"


def test_datasets(profile: str, wh: str, dashboard: dict[str, Any], schema: str) -> None:
    failed = []
    for ds in dashboard["datasets"]:
        res = run_sql("".join(ds["queryLines"]), profile, wh, schema=schema)
        if ok(res):
            rows = res.get("manifest", {}).get("total_row_count", 0)
            print(f"  {ds['name']:<22} {rows:>5} rows{'   <- empty' if rows == 0 else ''}")
        else:
            failed.append(ds["name"])
            print(f"  {ds['name']:<22} FAILED: {error(res)}")
    if failed:
        sys.exit(f"{len(failed)} dataset(s) failed; fix them before deploying: {', '.join(failed)}")


def deploy(profile: str, wh: str, dashboard: dict[str, Any], variant: str) -> str:
    _, schema, display_name, suffix = VARIANTS[variant]
    state = HERE / f".dashboard_id.{profile}{suffix}"  # one dashboard per workspace and variant
    serialized = json.dumps(dashboard)
    common = [
        "--warehouse-id",
        wh,
        "--dataset-catalog",
        CATALOG,
        "--dataset-schema",
        schema,
        "--display-name",
        display_name,
        "--serialized-dashboard",
        serialized,
    ]
    dashboard_id = state.read_text().strip() if state.exists() else ""
    if dashboard_id:
        try:
            cli(["lakeview", "update", dashboard_id, *common], profile)
            print(f"updated dashboard {dashboard_id}")
        except RuntimeError as e:
            print(f"update failed ({e}); creating a new dashboard")
            dashboard_id = ""
    if not dashboard_id:
        user = cli(["current-user", "me"], profile)["userName"]
        folder = f"/Workspace/Users/{user}/frostsight"
        cli(["workspace", "mkdirs", folder], profile)
        created = cli(["lakeview", "create", *common, "--json", json.dumps({"parent_path": folder})], profile)
        dashboard_id = created["dashboard_id"]
        state.write_text(dashboard_id + "\n")
        print(f"created dashboard {dashboard_id} in {folder}")
    cli(
        [
            "lakeview",
            "publish",
            dashboard_id,
            "--json",
            json.dumps({"warehouse_id": wh, "embed_credentials": True}),
        ],
        profile,
    )
    return dashboard_id


def share(profile: str, dashboard_id: str, group: str) -> None:
    acl = {"access_control_list": [{"group_name": group, "permission_level": "CAN_RUN"}]}
    cli(["permissions", "update", "dashboards", dashboard_id, "--json", json.dumps(acl)], profile)
    print(f"shared with group '{group}' (CAN_RUN)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--profile", default="frostsight-personal")
    p.add_argument("--warehouse-id", default=None)
    p.add_argument("--setup", action="store_true", help="run sql/001_catalog_schemas_volume.sql first")
    p.add_argument("--skip-load", action="store_true", help="demo: keep frostsight.mock as it is")
    p.add_argument("--dashboard", choices=sorted(VARIANTS), default="demo")
    p.add_argument("--load-reference", action="store_true", help="live: load silver.nvdb_seed_* first")
    p.add_argument("--share", metavar="GROUP", help="give this workspace group CAN_RUN, e.g. users")
    a = p.parse_args()

    wh = pick_warehouse(a.profile, a.warehouse_id)
    host = (
        cli(["auth", "env"], a.profile).get("env", {}).get("DATABRICKS_HOST", "<workspace host>").rstrip("/")
    )
    path, schema, _, _ = VARIANTS[a.dashboard]
    text = path.read_text()
    if a.dashboard == "live":
        if a.load_reference:
            load_reference(a.profile, wh)
        create_gold_views(a.profile, wh)
        text = text.replace("{{FETCH_URL}}", fetch_url(a.profile, host))
    elif not a.skip_load:
        load_mock(a.profile, wh, a.setup)
    dashboard = json.loads(text)
    print(f"datasets against {CATALOG}.{schema}:")
    test_datasets(a.profile, wh, dashboard, schema)
    dashboard_id = deploy(a.profile, wh, dashboard, a.dashboard)
    if a.share:
        share(a.profile, dashboard_id, a.share)
    print(f"draft:     {host}/sql/dashboardsv3/{dashboard_id}")
    print(f"published: {host}/sql/dashboardsv3/{dashboard_id}/published")


if __name__ == "__main__":
    main()
