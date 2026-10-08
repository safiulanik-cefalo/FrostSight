# Databricks notebook source
# MAGIC %md
# MAGIC # MET Frost historical observations
# MAGIC
# MAGIC Production bronze loader. Runs serverless (no cluster, no RDD API). Writes the raw response
# MAGIC body plus an ingestion timestamp to `frostsight.bronze.frost_observation_history_bronze` with `mode("append")` — no
# MAGIC parsing here; see `notebooks/silver_layer_transformation/12_frost_observation_history.py` for the parsed
# MAGIC version of this source.
# MAGIC
# MAGIC MET Frost `/observations/v0.jsonld`, one call per station per calendar month in `[date_from, date_to)` (docs/plan/02_M1_history_and_reference_data.md T1.4). About 30 stations times 5 months is up to 150 requests; Frost allows a few requests per second and the retry session backs off on 429. A 412 ("no data found for this combination") is skipped, not an error. Skips the whole run when `frost_client_id` is missing.


# COMMAND ----------

dbutils.widgets.text("catalog", "frostsight", "Unity Catalog catalog")
dbutils.widgets.text("county", "55", "NVDB fylke number (pilot: Troms, ADR-0002)")

CATALOG = dbutils.widgets.get("catalog")
COUNTY = dbutils.widgets.get("county")
BRONZE_TABLE = f"{CATALOG}.bronze.frost_observation_history_bronze"

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
dbutils.widgets.text("date_from", "2025-11-01", "History window start (YYYY-MM-DD)")
dbutils.widgets.text("date_to", "2026-04-01", "History window end (YYYY-MM-DD), exclusive")
DATE_FROM = dbutils.widgets.get("date_from")
DATE_TO = dbutils.widgets.get("date_to")

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

SOURCE = "frost_observation_history"
FROST_BASE = "https://frost.met.no"
COUNTY_NAMES = {"55": "Troms", "34": "Innlandet"}
ELEMENTS = ["air_temperature", "road_surface_temperature", "dew_point_temperature",
            "relative_humidity", "wind_speed", "wind_from_direction", "sum(precipitation_amount PT10M)"]

frost_client_id = get_secret("frost_client_id")
if not frost_client_id:
    print(f"{SOURCE}: secret 'frost_client_id' not set in scope '{SECRET_SCOPE}'; skipping this run")
    dbutils.notebook.exit(f"skipped: {SOURCE} credentials not configured")
auth = (frost_client_id, "")   # Frost: client id is the basic-auth username, password is empty

# COMMAND ----------

import datetime as dt


def month_windows(start: dt.date, end: dt.date):
    """[start, end) split at month boundaries (collector/frost.py, docs/plan/02_M1 T1.4): Frost limits
    rows per call, a month per station is safe."""
    cur = start
    while cur < end:
        nxt = dt.date(cur.year + (cur.month == 12), (cur.month % 12) + 1, 1)
        yield cur, min(nxt, end)
        cur = nxt


src_resp = http_get(f"{FROST_BASE}/sources/v0.jsonld", auth=auth,
                     params={"stationholder": "STATENS VEGVESEN", "county": COUNTY_NAMES.get(COUNTY, COUNTY)})
source_ids = [s["id"] for s in src_resp.json().get("data", [])]
print(f"{len(source_ids)} Frost sources in county {COUNTY}")

# COMMAND ----------

start = dt.date.fromisoformat(DATE_FROM)
end = dt.date.fromisoformat(DATE_TO)

rows = []
for source_id in source_ids:
    for m0, m1 in month_windows(start, end):
        params = {
            "sources": source_id, "elements": ",".join(ELEMENTS),
            "referencetime": f"{m0:%Y-%m-%d}/{m1:%Y-%m-%d}",
            "timeresolutions": "PT10M", "timeoffsets": "default", "levels": "default",
        }
        try:
            resp = http_get(f"{FROST_BASE}/observations/v0.jsonld", auth=auth, params=params)
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 412:
                continue   # Frost: "no data found for this combination"
            raise
        rows.append({"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
                    "raw_json_payload": resp.text})

# COMMAND ----------

if not rows:
    raise RuntimeError(f"{SOURCE}: no rows collected; nothing written to bronze")

bronze_df = (spark.createDataFrame(rows).withColumn("ingestion_timestamp", F.current_timestamp()))

(bronze_df.write.format("delta").mode("append").saveAsTable(BRONZE_TABLE))

print(f"wrote {bronze_df.count()} new row(s) to {BRONZE_TABLE}")
