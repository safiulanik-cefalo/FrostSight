# Databricks notebook source
# MAGIC %md
# MAGIC # DATEX measurement site table
# MAGIC
# MAGIC Production bronze loader. Runs serverless (no cluster, no RDD API). Writes the raw response
# MAGIC body plus an ingestion timestamp to `frostsight.bronze.datex_site_table_bronze` with `mode("append")` — no
# MAGIC parsing here; see `notebooks/silver_layer_transformation/10_datex_site_table.py` for the parsed
# MAGIC version of this source.
# MAGIC
# MAGIC The open WFS has no separate site-table endpoint (ADR-0008): sites are built from the same `datex_3_1:WeatherSimple_v2` response as `08_datex_road_weather.py` (point geometry, `REFERENCE_ID`). Changes rarely; sensible to run weekly, not every 10 minutes.


# COMMAND ----------

dbutils.widgets.text("catalog", "frostsight", "Unity Catalog catalog")
dbutils.widgets.text("county", "55", "NVDB fylke number (pilot: Troms, ADR-0002)")

CATALOG = dbutils.widgets.get("catalog")
COUNTY = dbutils.widgets.get("county")
BRONZE_TABLE = f"{CATALOG}.bronze.datex_site_table_bronze"

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

SOURCE = "datex_site_table"
DATEX_WFS_BASE = "https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs"
WFS_PARAMS = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
              "typeNames": "datex_3_1:WeatherSimple_v2", "outputFormat": "application/json"}

# COMMAND ----------

resp = http_get(DATEX_WFS_BASE, params=WFS_PARAMS)
rows = [{"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
         "raw_json_payload": resp.text}]

# COMMAND ----------

if not rows:
    raise RuntimeError(f"{SOURCE}: no rows collected; nothing written to bronze")

bronze_df = (spark.createDataFrame(rows).withColumn("ingestion_timestamp", F.current_timestamp()))

(bronze_df.write.format("delta").mode("append").saveAsTable(BRONZE_TABLE))

print(f"wrote {bronze_df.count()} new row(s) to {BRONZE_TABLE}")
