# Databricks notebook source
# MAGIC %md
# MAGIC # MET Frost station sources
# MAGIC
# MAGIC Production bronze loader. Runs serverless (no cluster, no RDD API). Writes the raw response
# MAGIC body plus an ingestion timestamp to `frostsight.bronze.frost_station_source_bronze` with `mode("append")` — no
# MAGIC parsing here; see `notebooks/silver_layer_transformation/11_frost_station_source.py` for the parsed
# MAGIC version of this source.
# MAGIC
# MAGIC MET Frost `/sources/v0.jsonld`, Statens vegvesen stations for the county (docs/plan/02_M1_history_and_reference_data.md T1.4). Skips the run when `frost_client_id` is missing.


# COMMAND ----------

dbutils.widgets.text("catalog", "frostsight", "Unity Catalog catalog")
dbutils.widgets.text("county", "55", "NVDB fylke number (pilot: Troms, ADR-0002)")

CATALOG = dbutils.widgets.get("catalog")
COUNTY = dbutils.widgets.get("county")
BRONZE_TABLE = f"{CATALOG}.bronze.frost_station_source_bronze"

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.bronze")
dbutils.widgets.text("secret_scope", "frostsight", "Secret scope (docs/plan/01_M0_accounts_and_sources.md T0.4)")
SECRET_SCOPE = dbutils.widgets.get("secret_scope")


def get_secret(key: str):
    """None if the scope or key does not exist yet, so a missing credential skips the run instead of
    crashing the job (same convention as collector/ingest_bronze.py)."""
    try:
        return dbutils.secrets.get(SECRET_SCOPE, key)
    except Exception:
        return None

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

SOURCE = "frost_station_source"
FROST_BASE = "https://frost.met.no"
COUNTY_NAMES = {"55": "Troms", "34": "Innlandet"}   # Frost documents county as a name, not a number

frost_client_id = get_secret("frost_client_id")
if not frost_client_id:
    print(f"{SOURCE}: secret 'frost_client_id' not set in scope '{SECRET_SCOPE}'; skipping this run")
    dbutils.notebook.exit(f"skipped: {SOURCE} credentials not configured")
auth = (frost_client_id, "")   # Frost: client id is the basic-auth username, password is empty

# COMMAND ----------

resp = http_get(f"{FROST_BASE}/sources/v0.jsonld", auth=auth,
                 params={"stationholder": "STATENS VEGVESEN", "county": COUNTY_NAMES.get(COUNTY, COUNTY)})
rows = [{"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
         "raw_json_payload": resp.text}]

# COMMAND ----------

if not rows:
    raise RuntimeError(f"{SOURCE}: no rows collected; nothing written to bronze")

bronze_df = (spark.createDataFrame(rows).withColumn("ingestion_timestamp", F.current_timestamp()))

(bronze_df.write.format("delta").mode("append").saveAsTable(BRONZE_TABLE))

print(f"wrote {bronze_df.count()} new row(s) to {BRONZE_TABLE}")
