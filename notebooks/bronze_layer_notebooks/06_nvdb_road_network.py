# Databricks notebook source
# MAGIC %md
# MAGIC # NVDB road network segments
# MAGIC
# MAGIC Production bronze loader. Runs serverless (no cluster, no RDD API). Writes the raw response
# MAGIC body plus an ingestion timestamp to `frostsight.bronze.nvdb_road_network_bronze` with `mode("append")` — no
# MAGIC parsing here; see `notebooks/silver_layer_transformation/06_nvdb_road_network.py` for the parsed
# MAGIC version of this source.
# MAGIC
# MAGIC `vegnett/veglenkesekvenser/segmentert`, the full county road graph -- tens of thousands of segments, many pages; expect 5 to 15 minutes (docs/plan/02_M1_history_and_reference_data.md T1.3). srid=25833 so the landed WKT states the horizontal CRS silver uses.


# COMMAND ----------

dbutils.widgets.text("catalog", "frostsight", "Unity Catalog catalog")
dbutils.widgets.text("county", "55", "NVDB fylke number (pilot: Troms, ADR-0002)")

CATALOG = dbutils.widgets.get("catalog")
COUNTY = dbutils.widgets.get("county")
BRONZE_TABLE = f"{CATALOG}.bronze.nvdb_road_network_bronze"

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.bronze")

# COMMAND ----------

import time

import requests
from pyspark.sql import functions as F

USER_AGENT = "frostsight-collector/0.1 (+github.com/safiulanik-cefalo/FrostSight)"


def http_get(url, retries=3, timeout=60, **kwargs):
    """GET with retry and backoff on 429 and 5xx (same convention as collector/ingest_bronze.py's
    http() helper). Raises after the last attempt so a persistent failure still fails the job."""
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    last_err = None
    for attempt in range(retries):
        resp = session.get(url, timeout=timeout, **kwargs)
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = int(resp.headers.get("Retry-After", 2 ** (attempt + 1)))
            last_err = f"HTTP {resp.status_code}"
            time.sleep(min(wait, 60))
            continue
        resp.raise_for_status()
        return resp
    raise RuntimeError(f"GET {url} failed after {retries} attempts: {last_err}")


def http_post(url, retries=3, timeout=60, **kwargs):
    """POST with the same retry convention as http_get, for the one GraphQL source."""
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Content-Type": "application/json"})
    last_err = None
    for attempt in range(retries):
        resp = session.post(url, timeout=timeout, **kwargs)
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = int(resp.headers.get("Retry-After", 2 ** (attempt + 1)))
            last_err = f"HTTP {resp.status_code}"
            time.sleep(min(wait, 60))
            continue
        resp.raise_for_status()
        return resp
    raise RuntimeError(f"POST {url} failed after {retries} attempts: {last_err}")

# COMMAND ----------

SOURCE = "nvdb_road_network"
NVDB_BASE = "https://nvdbapiles.atlas.vegvesen.no"


def collect_nvdb_road_network():
    """Follows metadata.neste.href across every page of the segmented road-link walk
    (collector/nvdb.py iter_road_links, docs/plan/02_M1_history_and_reference_data.md T1.3)."""
    headers = {"Accept": "application/json", "X-Client": "frostsight"}
    url = f"{NVDB_BASE}/vegnett/veglenkesekvenser/segmentert"
    params = {"fylke": COUNTY, "antall": 1000, "srid": 25833}
    out = []
    while url:
        resp = http_get(url, headers=headers, params=params)
        out.append({"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
                    "raw_json_payload": resp.text})
        nxt = (resp.json().get("metadata") or {}).get("neste")
        url, params = (nxt["href"], None) if nxt else (None, None)
    return out

# COMMAND ----------

rows = collect_nvdb_road_network()

# COMMAND ----------

if not rows:
    raise RuntimeError(f"{SOURCE}: no rows collected; nothing written to bronze")

bronze_df = (spark.createDataFrame(rows).withColumn("ingestion_timestamp", F.current_timestamp()))

(bronze_df.write.format("delta").mode("append").saveAsTable(BRONZE_TABLE))

print(f"wrote {bronze_df.count()} new row(s) to {BRONZE_TABLE}")
