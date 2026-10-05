# Databricks notebook source
# MAGIC %md
# MAGIC # WinterRoad · E1 · Ingestion to bronze
# MAGIC
# MAGIC Owner: Shaid Hasan Shawon (E1 · Ingestion and streaming)
# MAGIC
# MAGIC This notebook has two stages. Each run can do one or both:
# MAGIC
# MAGIC 1. **Collect.** Calls each source API and writes the raw response to a Unity Catalog volume,
# MAGIC    one folder per source: `/Volumes/<catalog>/bronze/landing/<source>/ingest_date=YYYY-MM-DD/<run_ts>.json`.
# MAGIC    Every file is JSON Lines. Each line is an envelope (`source`, `fetched_at`, `request_url`,
# MAGIC    `http_status`, ...) plus either the parsed `record` (JSON APIs) or the untouched `payload_raw` text (DATEX II XML).
# MAGIC 2. **Bronze.** Auto Loader reads each landing folder into an append-only Delta table in `<catalog>.bronze`,
# MAGIC    with its own checkpoint and schema location, `addNewColumns` schema evolution and a `_rescued_data` column.
# MAGIC    The stream runs with `trigger(availableNow=True)`, so one run picks up new files and stops.
# MAGIC
# MAGIC The deck puts the collector outside Databricks (GitHub Actions) because Free Edition limits outbound
# MAGIC internet. The collect stage is written so the same code works from a notebook if the workspace allows
# MAGIC egress; otherwise run with `stage = bronze` and let the external collector fill the volume in the same layout.
# MAGIC
# MAGIC **Sources and cadence.** The job is scheduled every 10 minutes. Each source has its own minimum interval,
# MAGIC so slow-moving sources are only called when they are due (state kept in `bronze._ingest_state`).
# MAGIC
# MAGIC | Source key | API | Interval | Auth |
# MAGIC |---|---|---|---|
# MAGIC | `datex_road_weather` | DATEX II GetMeasuredWeatherData | 10 min | Basic auth (secret) |
# MAGIC | `datex_situations` | DATEX II GetSituation | 10 min | Basic auth (secret) |
# MAGIC | `datex_weather_sites` | DATEX II GetMeasurementWeatherSiteTable | 1 day | Basic auth (secret) |
# MAGIC | `frost_sources` | MET Frost sources, holder Statens vegvesen | 1 day | Client ID (secret) |
# MAGIC | `frost_observations` | MET Frost observations | 1 h | Client ID (secret) |
# MAGIC | `met_locationforecast` | MET Locationforecast 2.0 at each road-weather station | 1 h | User-Agent |
# MAGIC | `trafikkdata_points` | trafikkdata.no registration points | 1 day | none |
# MAGIC | `trafikkdata_hourly_volume` | trafikkdata.no hourly volumes | 1 h | none |
# MAGIC | `nvdb_<type>` | NVDB API Les v4 object types 153, 570, 445, 482, 105 | 7 days | X-Client header |
# MAGIC | `nvdb_road_links` | NVDB road link sequences | 7 days | X-Client header |
# MAGIC
# MAGIC Sources without credentials (DATEX, Frost) are skipped with a log line, not a failure.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parameters

# COMMAND ----------

dbutils.widgets.text("catalog", "winterroad", "Catalog")
dbutils.widgets.text("county", "55", "NVDB / trafikkdata county number (55 = Troms)")
dbutils.widgets.dropdown("stage", "all", ["all", "collect", "bronze"], "Stage")
dbutils.widgets.text("sources", "all", "Sources (comma list or 'all')")
dbutils.widgets.dropdown("force", "false", ["false", "true"], "Ignore intervals")
dbutils.widgets.text("secret_scope", "winterroad", "Secret scope")
dbutils.widgets.text("contact", "winterroad-e1 shaid.shawon@cefalo.com", "Contact for User-Agent / X-Client")

CATALOG = dbutils.widgets.get("catalog")
COUNTY = int(dbutils.widgets.get("county"))
STAGE = dbutils.widgets.get("stage")
SOURCES_FILTER = dbutils.widgets.get("sources").strip()
FORCE = dbutils.widgets.get("force") == "true"
SECRET_SCOPE = dbutils.widgets.get("secret_scope")
CONTACT = dbutils.widgets.get("contact")

SCHEMA = "bronze"
LANDING = f"/Volumes/{CATALOG}/{SCHEMA}/landing"
CHECKPOINTS = f"/Volumes/{CATALOG}/{SCHEMA}/checkpoints"
STATE_TABLE = f"{CATALOG}.{SCHEMA}._ingest_state"

# All timestamps in this notebook are UTC.
spark.conf.set("spark.sql.session.timeZone", "UTC")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup: schema, volumes, state table

# COMMAND ----------

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
spark.sql(f"CREATE VOLUME IF NOT EXISTS {CATALOG}.{SCHEMA}.landing COMMENT 'Raw API responses, one folder per source'")
spark.sql(f"CREATE VOLUME IF NOT EXISTS {CATALOG}.{SCHEMA}.checkpoints COMMENT 'Auto Loader checkpoints and schema locations'")
spark.sql(f"""
    CREATE TABLE IF NOT EXISTS {STATE_TABLE} (
        source STRING,
        run_ts TIMESTAMP,
        status STRING,
        records BIGINT,
        files ARRAY<STRING>,
        message STRING
    ) COMMENT 'One row per collector attempt. Drives per-source intervals and freshness checks.'
""")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Collector helpers

# COMMAND ----------

import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import requests

USER_AGENT = f"winterroad/0.1 ({CONTACT})"
NVDB_BASE = "https://nvdbapiles.atlas.vegvesen.no"
TRAFIKKDATA_URL = "https://trafikkdata-api.atlas.vegvesen.no/"
MET_FORECAST_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"
FROST_BASE = "https://frost.met.no"
DATEX_BASE = "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi"

session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT})


def get_secret(key):
    """Return a secret or None if the scope or key does not exist yet."""
    try:
        return dbutils.secrets.get(SECRET_SCOPE, key)
    except Exception:
        return None


def http(method, url, retries=3, timeout=60, **kwargs):
    """HTTP call with retry and backoff on 429, 5xx and network errors."""
    last_err = None
    for attempt in range(retries):
        try:
            resp = session.request(method, url, timeout=timeout, **kwargs)
            if resp.status_code == 429 or resp.status_code >= 500:
                wait = int(resp.headers.get("Retry-After", 2 ** (attempt + 1)))
                last_err = f"HTTP {resp.status_code}"
                time.sleep(min(wait, 60))
                continue
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:
            last_err = str(e)
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"{method} {url} failed after {retries} attempts: {last_err}")


class Landing:
    """Buffers envelope lines for one source and writes them as a JSON Lines file in the volume."""

    def __init__(self, source, run_ts):
        self.source = source
        self.run_ts = run_ts
        self.lines = []
        self.files = []
        self.written = 0

    def add(self, request_url, http_status, record=None, payload_raw=None, content_type=None, params=None):
        self.lines.append(json.dumps({
            "source": self.source,
            "run_id": RUN_ID,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "request_url": request_url,
            "request_params": json.dumps(params, ensure_ascii=False) if params else None,
            "http_status": http_status,
            "content_type": content_type,
            "record": record,
            "payload_raw": payload_raw,
        }, ensure_ascii=False))

    def flush(self):
        if not self.lines:
            return
        folder = f"{LANDING}/{self.source}/ingest_date={self.run_ts:%Y-%m-%d}"
        os.makedirs(folder, exist_ok=True)
        path = f"{folder}/{self.run_ts:%Y%m%dT%H%M%SZ}_{uuid.uuid4().hex[:8]}.json"
        # Write to a temp name first so Auto Loader never sees a half-written file.
        tmp = f"{folder}/_tmp_{uuid.uuid4().hex}"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(self.lines) + "\n")
        os.rename(tmp, path)
        self.files.append(path)
        self.written += len(self.lines)
        self.lines = []

RUN_ID = uuid.uuid4().hex
RUN_TS = datetime.now(timezone.utc)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Source clients
# MAGIC
# MAGIC Each client takes a `Landing` and returns the number of records written.

# COMMAND ----------

# ---------- NVDB API Les v4 ----------

NVDB_OBJECT_TYPES = {
    153: "nvdb_road_weather_stations",      # Værstasjon: station number + point geometry
    570: "nvdb_accidents",                  # Trafikkulykke: date, road, weather, surface condition
    445: "nvdb_avalanche_landslide",        # Skred: date, type, road damage
    482: "nvdb_traffic_registration_stations",
    105: "nvdb_speed_limits",
}
NVDB_PAGE_SIZE = 1000


def nvdb_paged(landing, path, params):
    """Follow NVDB v4 `metadata.neste` pagination and write one line per object."""
    headers = {"X-Client": CONTACT, "Accept": "application/json"}
    url = f"{NVDB_BASE}{path}"
    params = {**params, "antall": NVDB_PAGE_SIZE}
    n = 0
    while True:
        resp = http("GET", url, headers=headers, params=params)
        body = resp.json()
        objects = body.get("objekter", [])
        for obj in objects:
            landing.add(resp.url, resp.status_code, record=obj, content_type="application/json", params=params)
        n += len(objects)
        if len(landing.lines) >= 20000:
            landing.flush()
        nxt = (body.get("metadata") or {}).get("neste") or {}
        # NVDB signals the end with an empty page; do not assume the server honours antall.
        if not objects or not nxt.get("start") or nxt["start"] == params.get("start"):
            break
        params = {**params, "start": nxt["start"]}
    return n


def make_nvdb_collector(type_id):
    def collect(landing):
        return nvdb_paged(landing, f"/vegobjekter/{type_id}", {
            "fylke": COUNTY,
            "inkluder": "metadata,egenskaper,geometri,lokasjon,relasjoner",
            "srid": 4326,  # note: NVDB returns 4326 WKT as POINT(lat lon)
        })
    return collect


def collect_nvdb_road_links(landing):
    return nvdb_paged(landing, "/vegnett/veglenkesekvenser", {"fylke": COUNTY, "srid": 4326})


# ---------- trafikkdata.no GraphQL ----------

def graphql(query, variables=None):
    resp = http("POST", TRAFIKKDATA_URL, json={"query": query, "variables": variables or {}},
                headers={"Content-Type": "application/json"})
    body = resp.json()
    if body.get("errors"):
        raise RuntimeError(f"trafikkdata GraphQL errors: {body['errors']}")
    return resp, body["data"]


POINTS_QUERY = """
query($county: PositiveInt!) {
  trafficRegistrationPoints(searchQuery: {countyNumbers: [$county]}) {
    id name trafficRegistrationType
    location {
      coordinates { latLon { lat lon } }
      roadReference { shortForm }
      municipality { name number }
    }
    operationalStatus
  }
}"""

VOLUME_QUERY = """
query($id: String!, $from: ZonedDateTime!, $to: ZonedDateTime!, $after: String) {
  trafficData(trafficRegistrationPointId: $id) {
    volume {
      byHour(from: $from, to: $to, after: $after) {
        edges { node {
          from to
          total { volumeNumbers { volume } coverage { percentage } }
        } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}"""


def trafikkdata_point_ids():
    _, data = graphql(POINTS_QUERY, {"county": COUNTY})
    return [p["id"] for p in data["trafficRegistrationPoints"]]


def collect_trafikkdata_points(landing):
    resp, data = graphql(POINTS_QUERY, {"county": COUNTY})
    points = data["trafficRegistrationPoints"]
    for p in points:
        landing.add(TRAFIKKDATA_URL, resp.status_code, record=p, content_type="application/json",
                    params={"county": COUNTY})
    return len(points)


def collect_trafikkdata_hourly_volume(landing):
    # Pull the last 6 complete hours every run; silver dedups on (point, from).
    to_ts = RUN_TS.replace(minute=0, second=0, microsecond=0)
    from_ts = to_ts - timedelta(hours=6)
    n = 0
    for point_id in trafikkdata_point_ids():
        after = None
        while True:
            variables = {"id": point_id, "from": from_ts.isoformat(), "to": to_ts.isoformat(), "after": after}
            try:
                resp, data = graphql(VOLUME_QUERY, variables)
            except RuntimeError as e:
                # Some points have no volume data (e.g. out of service); log and move on.
                print(f"  trafikkdata {point_id}: {e}")
                break
            by_hour = data["trafficData"]["volume"]["byHour"]
            for edge in by_hour["edges"]:
                landing.add(TRAFIKKDATA_URL, resp.status_code,
                            record={"trafficRegistrationPointId": point_id, **edge["node"]},
                            content_type="application/json", params=variables)
                n += 1
            if not by_hour["pageInfo"]["hasNextPage"]:
                break
            after = by_hour["pageInfo"]["endCursor"]
    return n


# ---------- MET Locationforecast ----------

def road_weather_station_points():
    """(station_number, name, lat, lon) for the county's road-weather stations, from NVDB type 153."""
    resp = http("GET", f"{NVDB_BASE}/vegobjekter/153",
                headers={"X-Client": CONTACT, "Accept": "application/json"},
                params={"fylke": COUNTY, "inkluder": "egenskaper,geometri", "srid": 4326, "antall": 1000})
    stations = []
    for obj in resp.json().get("objekter", []):
        props = {e["navn"]: e.get("verdi") for e in obj.get("egenskaper", [])}
        wkt = (obj.get("geometri") or {}).get("wkt", "")
        coords = wkt[wkt.find("(") + 1: wkt.find(")")].split()
        if len(coords) < 2:
            continue
        lat, lon = float(coords[0]), float(coords[1])  # NVDB 4326 WKT is lat, lon
        stations.append((props.get("Målestasjonsnummer"), props.get("Navn"), round(lat, 4), round(lon, 4)))
    return stations


def collect_met_locationforecast(landing):
    n = 0
    for station_no, name, lat, lon in road_weather_station_points():
        params = {"lat": lat, "lon": lon}
        resp = http("GET", MET_FORECAST_URL, params=params)
        landing.add(resp.url, resp.status_code, content_type="application/json", params=params, record={
            "station_number": station_no,
            "station_name": name,
            "lat": lat,
            "lon": lon,
            "forecast": resp.json(),
        })
        n += 1
        time.sleep(0.2)  # stay well inside MET's fair-use limits
    return n


# ---------- MET Frost ----------

FROST_ELEMENTS = [
    "air_temperature",
    "surface_temperature",
    "dew_point_temperature",
    "relative_humidity",
    "wind_speed",
    "sum(precipitation_amount PT10M)",
]


def frost_auth():
    client_id = get_secret("frost-client-id")
    return (client_id, "") if client_id else None


def frost_source_ids(auth):
    resp = http("GET", f"{FROST_BASE}/sources/v0.jsonld", auth=auth,
                params={"stationholder": "STATENS VEGVESEN", "county": COUNTY})
    return resp, resp.json().get("data", [])


def collect_frost_sources(landing):
    auth = frost_auth()
    if not auth:
        raise SkipSource("secret 'frost-client-id' not set")
    resp, sources = frost_source_ids(auth)
    for s in sources:
        landing.add(resp.url, resp.status_code, record=s, content_type="application/ld+json")
    return len(sources)


def collect_frost_observations(landing):
    auth = frost_auth()
    if not auth:
        raise SkipSource("secret 'frost-client-id' not set")
    _, sources = frost_source_ids(auth)
    ids = [s["id"] for s in sources]
    # Last 3 hours on every run; overlap is intentional, silver dedups on (source, element, time).
    end = RUN_TS.replace(second=0, microsecond=0)
    start = end - timedelta(hours=3)
    n = 0
    for i in range(0, len(ids), 20):
        params = {
            "sources": ",".join(ids[i:i + 20]),
            "elements": ",".join(FROST_ELEMENTS),
            "referencetime": f"{start:%Y-%m-%dT%H:%M:%SZ}/{end:%Y-%m-%dT%H:%M:%SZ}",
        }
        resp = session.get(f"{FROST_BASE}/observations/v0.jsonld", params=params, auth=auth, timeout=120)
        if resp.status_code == 404:  # Frost returns 404 when no data matches
            continue
        resp.raise_for_status()
        for obs in resp.json().get("data", []):
            landing.add(resp.url, resp.status_code, record=obs, content_type="application/ld+json", params=params)
            n += 1
    return n


# ---------- DATEX II (Statens vegvesen) ----------

def make_datex_collector(endpoint):
    def collect(landing):
        user, pwd = get_secret("datex-username"), get_secret("datex-password")
        if not (user and pwd):
            raise SkipSource("secrets 'datex-username' / 'datex-password' not set")
        url = f"{DATEX_BASE}/{endpoint}/pullsnapshotdata"
        resp = http("GET", url, auth=(user, pwd), timeout=180, headers={"Accept": "application/xml"})
        # Raw XML is kept as-is in bronze. The DATEX parser turns it into rows downstream.
        landing.add(url, resp.status_code, payload_raw=resp.text,
                    content_type=resp.headers.get("Content-Type"))
        return 1
    return collect


class SkipSource(Exception):
    pass

# COMMAND ----------

# MAGIC %md
# MAGIC ## Source registry

# COMMAND ----------

MIN = 60
HOUR = 3600
DAY = 86400

# source key -> (collector, minimum interval in seconds)
SOURCES = {
    "datex_road_weather":        (make_datex_collector("GetMeasuredWeatherData"), 10 * MIN),
    "datex_situations":          (make_datex_collector("GetSituation"), 10 * MIN),
    "datex_weather_sites":       (make_datex_collector("GetMeasurementWeatherSiteTable"), DAY),
    "frost_sources":             (collect_frost_sources, DAY),
    "frost_observations":        (collect_frost_observations, HOUR),
    "met_locationforecast":      (collect_met_locationforecast, HOUR),
    "trafikkdata_points":        (collect_trafikkdata_points, DAY),
    "trafikkdata_hourly_volume": (collect_trafikkdata_hourly_volume, HOUR),
    "nvdb_road_links":           (collect_nvdb_road_links, 7 * DAY),
    **{name: (make_nvdb_collector(t), 7 * DAY) for t, name in NVDB_OBJECT_TYPES.items()},
}

if SOURCES_FILTER.lower() == "all":
    selected = list(SOURCES)
else:
    selected = [s.strip() for s in SOURCES_FILTER.split(",") if s.strip()]
    unknown = set(selected) - set(SOURCES)
    if unknown:
        raise ValueError(f"Unknown sources: {sorted(unknown)}. Known: {sorted(SOURCES)}")

print("Selected sources:", selected)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Stage 1 · Collect

# COMMAND ----------

from pyspark.sql import functions as F


def last_success():
    rows = (spark.table(STATE_TABLE)
            .where("status = 'ok'")
            .groupBy("source").agg(F.max("run_ts").alias("last_ok"))
            .collect())
    return {r.source: r.last_ok.replace(tzinfo=timezone.utc) for r in rows}


def is_due(source, interval, last_ok):
    if FORCE or source not in last_ok:
        return True
    # 60 s slack so a job that fires a little early does not skip a 10-minute source.
    return (RUN_TS - last_ok).total_seconds() >= interval - 60


collect_results = []

if STAGE in ("all", "collect"):
    last_ok = last_success()
    for source in selected:
        collector, interval = SOURCES[source]
        if not is_due(source, interval, last_ok):
            print(f"[skip] {source}: not due (last ok {last_ok[source]:%Y-%m-%d %H:%M} UTC)")
            continue
        landing = Landing(source, RUN_TS)
        t0 = time.time()
        try:
            n = collector(landing)
            landing.flush()
            status, msg = "ok", f"{time.time() - t0:.1f}s"
        except SkipSource as e:
            n, status, msg = 0, "skipped", str(e)
        except Exception as e:
            landing.flush()  # keep whatever was fetched before the failure
            n, status, msg = landing.written, "error", str(e)[:2000]
        print(f"[{status}] {source}: {n} records, {len(landing.files)} file(s) {msg}")
        collect_results.append((source, RUN_TS, status, n, landing.files, msg))

    if collect_results:
        (spark.createDataFrame(collect_results, schema=spark.table(STATE_TABLE).schema)
         .write.mode("append").saveAsTable(STATE_TABLE))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Stage 2 · Bronze (Auto Loader)
# MAGIC
# MAGIC One append-only Delta table per landing folder: `<catalog>.bronze.<source>`.
# MAGIC
# MAGIC - Checkpoint: `/Volumes/<catalog>/bronze/checkpoints/<source>/checkpoint`
# MAGIC - Schema location: `/Volumes/<catalog>/bronze/checkpoints/<source>/schema`
# MAGIC - Schema evolution: `addNewColumns`. When a source adds a field, Auto Loader records it and stops the
# MAGIC   stream with `UnknownFieldException`; the loop below restarts it once so the run still completes.
# MAGIC - Fields that do not fit the schema go to `_rescued_data`, never dropped.
# MAGIC - Added columns: `_source_file`, `_file_modified_at`, `_ingested_at`.

# COMMAND ----------

# Pinned envelope columns. `record` is inferred (and evolves) per source.
ENVELOPE_HINTS = ",".join([
    "source STRING", "run_id STRING", "fetched_at TIMESTAMP", "request_url STRING",
    "request_params STRING", "http_status INT", "content_type STRING", "payload_raw STRING",
])


def landing_has_files(source):
    try:
        return any(True for _ in dbutils.fs.ls(f"{LANDING}/{source}"))
    except Exception:
        return False


def load_bronze(source):
    target = f"{CATALOG}.{SCHEMA}.{source}"
    base = f"{CHECKPOINTS}/{source}"
    df = (spark.readStream.format("cloudFiles")
          .option("cloudFiles.format", "json")
          .option("cloudFiles.schemaLocation", f"{base}/schema")
          .option("cloudFiles.schemaEvolutionMode", "addNewColumns")
          .option("cloudFiles.schemaHints", ENVELOPE_HINTS)
          .option("cloudFiles.inferColumnTypes", "false")   # keep nested values as strings; typing happens in silver
          .option("rescuedDataColumn", "_rescued_data")
          .option("pathGlobFilter", "*.json")
          .option("multiLine", "false")
          .load(f"{LANDING}/{source}")
          .withColumn("_source_file", F.col("_metadata.file_path"))
          .withColumn("_file_modified_at", F.col("_metadata.file_modification_time"))
          .withColumn("_ingested_at", F.current_timestamp()))
    query = (df.writeStream
             .format("delta")
             .option("checkpointLocation", f"{base}/checkpoint")
             .option("mergeSchema", "true")
             .trigger(availableNow=True)
             .toTable(target))
    query.awaitTermination()
    return target


bronze_results = []

if STAGE in ("all", "bronze"):
    for source in selected:
        if not landing_has_files(source):
            print(f"[skip] bronze.{source}: no landing files yet")
            continue
        for attempt in (1, 2):
            try:
                target = load_bronze(source)
                rows = spark.table(target).count()
                print(f"[ok] {target}: {rows} rows total")
                bronze_results.append((source, "ok", rows))
                break
            except Exception as e:
                if attempt == 1 and "UnknownFieldException" in str(e):
                    print(f"[schema] {source}: new fields detected, restarting stream with evolved schema")
                    continue
                print(f"[error] bronze.{source}: {str(e)[:500]}")
                bronze_results.append((source, "error", None))
                break

# COMMAND ----------

# MAGIC %md
# MAGIC ## Run summary and freshness

# COMMAND ----------

display(spark.sql(f"""
    SELECT source,
           max_by(status, run_ts)                                   AS last_status,
           max(CASE WHEN status = 'ok' THEN run_ts END)             AS last_ok_utc,
           timestampdiff(MINUTE, max(CASE WHEN status = 'ok' THEN run_ts END), current_timestamp()) AS minutes_since_ok,
           max_by(message, run_ts)                                  AS last_message
    FROM {STATE_TABLE}
    GROUP BY source
    ORDER BY source
"""))

# Fail the job only on real errors, so the scheduler alerts. Skipped sources (no credentials yet) do not fail it.
errors = [r[0] for r in collect_results if r[2] == "error"] + [r[0] for r in bronze_results if r[1] == "error"]
if errors:
    raise RuntimeError(f"Ingestion errors in: {sorted(set(errors))}")
