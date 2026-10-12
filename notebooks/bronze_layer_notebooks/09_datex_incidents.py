# Databricks notebook source
# MAGIC %md
# MAGIC # DATEX incident snapshot
# MAGIC
# MAGIC Production bronze loader. Runs serverless (no cluster, no RDD API). Writes the raw response
# MAGIC body plus an ingestion timestamp to `frostsight.bronze.datex_incidents_bronze` with `mode("append")` — no
# MAGIC parsing here; see `notebooks/silver_layer_transformation/09_datex_incidents.py` for the parsed
# MAGIC version of this source.
# MAGIC
# MAGIC Open Statens vegvesen WFS, layer `datex_3_1:SituationSimple_v2`, no auth, filtered to the county bbox from NVDB `omrader/fylker` (ADR-0008, docs/plan/02_M1_history_and_reference_data.md T1.5) -- national is 10 MB, the bbox is under 1 MB.


# COMMAND ----------

dbutils.widgets.text("catalog", "frostsight", "Unity Catalog catalog")
dbutils.widgets.text("county", "55", "NVDB fylke number (pilot: Troms, ADR-0002)")

CATALOG = dbutils.widgets.get("catalog")
COUNTY = dbutils.widgets.get("county")
BRONZE_TABLE = f"{CATALOG}.bronze.datex_incidents_bronze"

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

SOURCE = "datex_incidents"
DATEX_WFS_BASE = "https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs"

import re

NVDB_BASE = "https://nvdbapiles.atlas.vegvesen.no"
LATLON = re.compile(r"POLYGON\(\((.*)\)\)")


def county_bbox(county: str) -> str:
    """WFS 2.0 bbox for an NVDB county's kartutsnitt, lat before lon, matching collector/datex.py's
    county_bbox (ADR-0008)."""
    headers = {"Accept": "application/json", "X-Client": "frostsight"}
    resp = http_get(f"{NVDB_BASE}/omrader/fylker", headers=headers, params={"inkluder": "alle", "srid": 4326})
    fylke = next(f for f in resp.json() if str(f["nummer"]) == str(county))
    points = [tuple(map(float, p.split()))
              for p in LATLON.search(fylke["kartutsnitt"]["wkt"]).group(1).split(",")]
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    return f"{min(lats)},{min(lons)},{max(lats)},{max(lons)},urn:ogc:def:crs:EPSG::4326"

# COMMAND ----------

WFS_PARAMS = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
              "typeNames": "datex_3_1:SituationSimple_v2", "outputFormat": "application/json",
              "srsName": "EPSG:4326", "bbox": county_bbox(COUNTY)}

resp = http_get(DATEX_WFS_BASE, params=WFS_PARAMS)
rows = [{"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
         "raw_json_payload": resp.text}]

# COMMAND ----------

if not rows:
    raise RuntimeError(f"{SOURCE}: no rows collected; nothing written to bronze")

bronze_df = (spark.createDataFrame(rows).withColumn("ingestion_timestamp", F.current_timestamp()))

(bronze_df.write.format("delta").mode("append").saveAsTable(BRONZE_TABLE))

print(f"wrote {bronze_df.count()} new row(s) to {BRONZE_TABLE}")
