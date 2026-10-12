# Databricks notebook source
# MAGIC %md
# MAGIC # MET Locationforecast
# MAGIC
# MAGIC Production bronze loader. Runs serverless (no cluster, no RDD API). Writes the raw response
# MAGIC body plus an ingestion timestamp to `frostsight.bronze.met_locationforecast_bronze` with `mode("append")` — no
# MAGIC parsing here; see `notebooks/silver_layer_transformation/14_met_locationforecast.py` for the parsed
# MAGIC version of this source.
# MAGIC
# MAGIC Post-MVP batch source (`docs/plan/00_README.md` section 5). One call per road-weather station (same station points as the elevation notebook), with a courtesy delay between calls to stay inside MET's fair-use limits. Depends on `nvdb_weather_station_location_bronze` already existing.


# COMMAND ----------

# MAGIC %pip install pyproj

# COMMAND ----------

dbutils.widgets.text("catalog", "frostsight", "Unity Catalog catalog")
dbutils.widgets.text("county", "55", "NVDB fylke number (pilot: Troms, ADR-0002)")

CATALOG = dbutils.widgets.get("catalog")
COUNTY = dbutils.widgets.get("county")
BRONZE_TABLE = f"{CATALOG}.bronze.met_locationforecast_bronze"

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

from pyproj import Transformer

SOURCE = "met_locationforecast"
MET_FORECAST_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"
to_wgs84 = Transformer.from_crs("EPSG:25833", "EPSG:4326", always_xy=True)

import json
import re

STATIONS_TABLE = f"{CATALOG}.bronze.nvdb_weather_station_location_bronze"
STATION_NUMBER_PROPERTY = 3591   # Maalestasjonsnummer
WKT_POINT = re.compile(r"POINT\s*Z?\s*\(\s*([-\d.]+)\s+([-\d.]+)")

if not spark.catalog.tableExists(STATIONS_TABLE):
    raise RuntimeError(f"{STATIONS_TABLE} does not exist yet; run 01_nvdb_weather_station_location.py first")


def station_points():
    """(station_id, lat, lon) from every landed NVDB type-153 page: same WKT parse and
    EPSG:25833 -> EPSG:4326 projection as collector/elevation.py (docs/plan/02_M1_history_and_reference_data.md T1.6).
    Driver-side (not RDD/UDF) so this stays serverless-safe; the bronze table is small (county scale)."""
    points = []
    for row in spark.table(STATIONS_TABLE).select("raw_json_payload").collect():
        body = json.loads(row["raw_json_payload"])
        for obj in body.get("objekter", []):
            m = WKT_POINT.match((obj.get("geometri") or {}).get("wkt") or "")
            if not m:
                continue
            east, north = float(m.group(1)), float(m.group(2))
            lon, lat = to_wgs84.transform(east, north)
            props = {e["id"]: e.get("verdi") for e in obj.get("egenskaper", [])}
            points.append({"station_id": str(props.get(STATION_NUMBER_PROPERTY)),
                           "lat": round(lat, 6), "lon": round(lon, 6)})
    return points


points = station_points()
if not points:
    raise RuntimeError(f"no station points found in {STATIONS_TABLE}")
print(f"{len(points)} station points from {STATIONS_TABLE}")

# COMMAND ----------

rows = []
for p in points:
    params = {"lat": p["lat"], "lon": p["lon"]}
    resp = http_get(MET_FORECAST_URL, params=params)
    rows.append({"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
                "station_id": p["station_id"], "raw_json_payload": resp.text})
    time.sleep(0.2)

# COMMAND ----------

if not rows:
    raise RuntimeError(f"{SOURCE}: no rows collected; nothing written to bronze")

bronze_df = (spark.createDataFrame(rows).withColumn("ingestion_timestamp", F.current_timestamp()))

(bronze_df.write.format("delta").mode("append").saveAsTable(BRONZE_TABLE))

print(f"wrote {bronze_df.count()} new row(s) to {BRONZE_TABLE}")
