import re

from frostsight.serving import serving_tables
from tools.mock_dashboards.build_dashboard import LIVE_DATASETS, live_dashboard

TABLES = serving_tables("frostsight", 30, 5.0)
NAMES = [n for n, _ in TABLES]
# written by build_gold before the plot-ready tables, or by the team's silver notebooks
BASE = {
    "gold.road_weather_observation_log",
    "gold.road_segment_current_risk",
    "gold.road_segment_risk_history",
    "gold.road_incidents",
    "gold.incident_summary",
    "silver.nvdb_seed_stations",
    "silver.nvdb_seed_segments",
    "silver.nvdb_seed_road_points",
}
# what a live dataset may read: a plot-ready table, or a gold table that is already one row per plotted item
LIVE_READS = set(NAMES) | {"road_incidents", "data_quality_summary", "data_quality_summary_history"}


def test_names_are_unique_and_sql_is_resolved():
    assert len(NAMES) == len(set(NAMES))
    for name, sql in TABLES:
        assert "{" not in sql and "}" not in sql, name


def test_each_table_reads_only_base_tables_or_ones_built_before_it():
    for i, (name, sql) in enumerate(TABLES):
        reads = set(re.findall(r"frostsight\.((?:gold|silver)\.\w+)", sql))
        allowed = BASE | {f"gold.{n}" for n in NAMES[:i]}
        assert reads <= allowed, (name, reads - allowed)


def test_every_live_dataset_is_a_select_on_one_table():
    for name, (_, sql) in LIVE_DATASETS.items():
        tables = re.findall(r"\b(?:FROM|JOIN)\s+(\w+)", sql, re.IGNORECASE)
        assert len(tables) == 1, (name, tables)
        assert tables[0] in LIVE_READS, (name, tables[0])


def test_live_dashboard_uses_every_live_dataset_and_no_other():
    d = live_dashboard()
    used = {
        q["query"]["datasetName"]
        for p in d["pages"]
        for i in p["layout"]
        for q in i["widget"].get("queries", [])
    }
    assert used == set(LIVE_DATASETS)
