"""Load the mock gold layer into a workspace and publish the FrostSight demo dashboard on it.

1. Runs mock_data.sql one statement at a time on a SQL warehouse (creates or replaces frostsight.mock).
2. Runs every dataset of frostsight_demo.lvdash.json against frostsight.mock and prints its row count,
   as the dashboard skill requires before a deploy.
3. Creates the dashboard (or updates the one recorded in .dashboard_id) and publishes it.

Nothing outside frostsight.mock and the one dashboard is touched. Personal workspace by default.

Run: uv run python tools/mock_dashboards/deploy.py [--profile NAME] [--warehouse-id ID] [--setup]
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
MOCK_SQL = HERE / "mock_data.sql"
SETUP_SQL = REPO / "sql" / "001_catalog_schemas_volume.sql"
DASHBOARD_JSON = HERE / "frostsight_demo.lvdash.json"
STATE = HERE / ".dashboard_id"
CATALOG, SCHEMA = "frostsight", "mock"
DISPLAY_NAME = "FrostSight demo (mock data)"
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

    script = MOCK_SQL.read_text().replace("{geometry_expr}", geometry)
    tmp = HERE / ".mock_data.resolved.sql"
    tmp.write_text(script)
    try:
        for i, s in enumerate(statements(tmp), 1):
            res = run_sql(s, profile, wh)
            if not ok(res):
                sys.exit(f"mock_data.sql statement {i} failed:\n{s[:300]}\n{error(res)}")
    finally:
        tmp.unlink(missing_ok=True)
    print(f"loaded {CATALOG}.{SCHEMA}")


def test_datasets(profile: str, wh: str, dashboard: dict[str, Any]) -> None:
    failed = []
    for ds in dashboard["datasets"]:
        res = run_sql("".join(ds["queryLines"]), profile, wh, schema=SCHEMA)
        if ok(res):
            rows = res.get("manifest", {}).get("total_row_count", 0)
            print(f"  {ds['name']:<22} {rows:>5} rows{'   <- empty' if rows == 0 else ''}")
        else:
            failed.append(ds["name"])
            print(f"  {ds['name']:<22} FAILED: {error(res)}")
    if failed:
        sys.exit(f"{len(failed)} dataset(s) failed; fix them before deploying: {', '.join(failed)}")


def deploy(profile: str, wh: str, dashboard: dict[str, Any]) -> str:
    serialized = json.dumps(dashboard)
    common = [
        "--warehouse-id",
        wh,
        "--dataset-catalog",
        CATALOG,
        "--dataset-schema",
        SCHEMA,
        "--display-name",
        DISPLAY_NAME,
        "--serialized-dashboard",
        serialized,
    ]
    dashboard_id = STATE.read_text().strip() if STATE.exists() else ""
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
        STATE.write_text(dashboard_id + "\n")
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


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--profile", default="frostsight-personal")
    p.add_argument("--warehouse-id", default=None)
    p.add_argument("--setup", action="store_true", help="run sql/001_catalog_schemas_volume.sql first")
    p.add_argument("--skip-load", action="store_true", help="keep frostsight.mock as it is")
    a = p.parse_args()

    wh = pick_warehouse(a.profile, a.warehouse_id)
    if not a.skip_load:
        load_mock(a.profile, wh, a.setup)
    dashboard = json.loads(DASHBOARD_JSON.read_text())
    print("datasets against frostsight.mock:")
    test_datasets(a.profile, wh, dashboard)
    dashboard_id = deploy(a.profile, wh, dashboard)
    host = (
        cli(["auth", "env"], a.profile).get("env", {}).get("DATABRICKS_HOST", "<workspace host>").rstrip("/")
    )
    print(f"draft:     {host}/sql/dashboardsv3/{dashboard_id}")
    print(f"published: {host}/sql/dashboardsv3/{dashboard_id}/published")


if __name__ == "__main__":
    main()
