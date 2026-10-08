"""One-off generator for the production bronze notebooks in this folder. Not part of the shipped
code; run again by hand if a source's endpoint, pagination or auth changes.

Each notebook is a standalone, serverless-safe Databricks notebook (no RDD API, no cluster config)
that calls one source from docs/plan/ with retries, and appends the raw response body plus an
ingestion timestamp to frostsight.bronze.<source>_bronze. No parsing happens here; see
notebooks/silver_layer_transformation/ for the parsed/normalised version of the same sources.
"""

from __future__ import annotations

from pathlib import Path

OUT = Path(__file__).resolve().parent

HEADER_TMPL = '''# Databricks notebook source
# MAGIC %md
# MAGIC # {title}
# MAGIC
# MAGIC Production bronze loader. Runs serverless (no cluster, no RDD API). Writes the raw response
# MAGIC body plus an ingestion timestamp to `frostsight.bronze.{table}` with `mode("append")` — no
# MAGIC parsing here; see `notebooks/silver_layer_transformation/{silver_notebook}` for the parsed
# MAGIC version of this source.
# MAGIC
# MAGIC {notes}
'''

CELL_SEP = "\n\n# COMMAND ----------\n\n"

WIDGETS_BASE = '''dbutils.widgets.text("catalog", "frostsight", "Unity Catalog catalog")
dbutils.widgets.text("county", "55", "NVDB fylke number (pilot: Troms, ADR-0002)")

CATALOG = dbutils.widgets.get("catalog")
COUNTY = dbutils.widgets.get("county")
BRONZE_TABLE = f"{{CATALOG}}.bronze.{table}"

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {{CATALOG}}.bronze")'''

WIDGETS_WITH_SECRETS = WIDGETS_BASE + '''
dbutils.widgets.text("secret_scope", "frostsight", "Secret scope (docs/plan/01_M0_accounts_and_sources.md T0.4)")
SECRET_SCOPE = dbutils.widgets.get("secret_scope")


def get_secret(key: str):
    """None if the scope or key does not exist yet, so a missing credential skips the run instead of
    crashing the job (same convention as collector/ingest_bronze.py)."""
    try:
        return dbutils.secrets.get(SECRET_SCOPE, key)
    except Exception:
        return None'''

HTTP_HELPER = '''import time

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
    raise RuntimeError(f"POST {url} failed after {retries} attempts: {last_err}")'''

WRITE_CELL = '''if not rows:
    raise RuntimeError(f"{SOURCE}: no rows collected; nothing written to bronze")

bronze_df = (spark.createDataFrame(rows).withColumn("ingestion_timestamp", F.current_timestamp()))

(bronze_df.write.format("delta").mode("append").saveAsTable(BRONZE_TABLE))

print(f"wrote {bronze_df.count()} new row(s) to {BRONZE_TABLE}")'''


def render(filename: str, title: str, table: str, silver_notebook: str, notes: str, cells: list[str]) -> None:
    header = HEADER_TMPL.format(title=title, table=table, silver_notebook=silver_notebook, notes=notes)
    content = header + CELL_SEP + CELL_SEP.join(cells) + "\n"
    (OUT / filename).write_text(content, encoding="utf-8")


NVDB_PAGINATE_HELPER = '''NVDB_BASE = "https://nvdbapiles.atlas.vegvesen.no"


def collect_nvdb_object_type(type_id: int, include: str, extra_params: dict | None = None):
    """Follows NVDB v4 metadata.neste.href across every page for the county -- one bronze row per
    page, matching collector/nvdb.py iter_pages (docs/plan/02_M1_history_and_reference_data.md T1.3).
    A page's neste.href already carries every query parameter, so later requests send no params."""
    headers = {"Accept": "application/json", "X-Client": "frostsight"}
    url = f"{NVDB_BASE}/vegobjekter/{type_id}"
    params = {"fylke": COUNTY, "antall": 1000, "inkluder": include, **(extra_params or {})}
    out = []
    while url:
        resp = http_get(url, headers=headers, params=params)
        out.append({"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
                    "raw_json_payload": resp.text})
        nxt = (resp.json().get("metadata") or {}).get("neste")
        url, params = (nxt["href"], None) if nxt else (None, None)
    return out'''

NVDB_INCLUDE = "lokasjon,geometri,egenskaper,vegsegmenter"


# ---------- 01 nvdb_weather_station_location (vegobjekter 153) ----------
render(
    "01_nvdb_weather_station_location.py",
    "NVDB weather station locations",
    "nvdb_weather_station_location_bronze",
    "01_nvdb_weather_station_location.py",
    "NVDB v4 object type 153 (Vaerstasjon), full county extract via `metadata.neste` pagination "
    "(docs/plan/02_M1_history_and_reference_data.md T1.3). About 30 stations in Troms, one page.",
    [
        WIDGETS_BASE.format(table="nvdb_weather_station_location_bronze"),
        HTTP_HELPER,
        f'''SOURCE = "nvdb_weather_station_location"
TYPE_ID = 153
INCLUDE = "{NVDB_INCLUDE}"

''' + NVDB_PAGINATE_HELPER,
        "rows = collect_nvdb_object_type(TYPE_ID, INCLUDE)",
        WRITE_CELL,
    ],
)


# ---------- 02 nvdb_traffic_station_location (vegobjekter 482) ----------
render(
    "02_nvdb_traffic_station_location.py",
    "NVDB traffic station locations",
    "nvdb_traffic_station_location_bronze",
    "02_nvdb_traffic_station_location.py",
    "NVDB v4 object type 482. Excluded from the MVP extract in docs/plan (`00_README.md` section 5: "
    "\"Yes, except 482\"); landed anyway since it is one of the object types config/sources.yml lists.",
    [
        WIDGETS_BASE.format(table="nvdb_traffic_station_location_bronze"),
        HTTP_HELPER,
        f'''SOURCE = "nvdb_traffic_station_location"
TYPE_ID = 482
INCLUDE = "{NVDB_INCLUDE}"

''' + NVDB_PAGINATE_HELPER,
        "rows = collect_nvdb_object_type(TYPE_ID, INCLUDE)",
        WRITE_CELL,
    ],
)


# ---------- 03 nvdb_speed_limit (vegobjekter 105) ----------
render(
    "03_nvdb_speed_limit.py",
    "NVDB speed limits",
    "nvdb_speed_limit_bronze",
    "03_nvdb_speed_limit.py",
    "NVDB v4 object type 105 (Fartsgrense), full county extract.",
    [
        WIDGETS_BASE.format(table="nvdb_speed_limit_bronze"),
        HTTP_HELPER,
        f'''SOURCE = "nvdb_speed_limit"
TYPE_ID = 105
INCLUDE = "{NVDB_INCLUDE}"

''' + NVDB_PAGINATE_HELPER,
        "rows = collect_nvdb_object_type(TYPE_ID, INCLUDE)",
        WRITE_CELL,
    ],
)


# ---------- 04 nvdb_accident (vegobjekter 570) ----------
render(
    "04_nvdb_accident.py",
    "NVDB accidents",
    "nvdb_accident_bronze",
    "04_nvdb_accident.py",
    "NVDB v4 object type 570 (Trafikkulykke), date-filtered on property 5055 (Ulykkesdato) from "
    "`date_from` -- five years of history is the documented policy "
    "(docs/plan/02_M1_history_and_reference_data.md T1.3).",
    [
        WIDGETS_BASE.format(table="nvdb_accident_bronze") + '''
dbutils.widgets.text("date_from", "2021-01-01", "Earliest accident date (property 5055 Ulykkesdato)")
DATE_FROM = dbutils.widgets.get("date_from")''',
        HTTP_HELPER,
        f'''SOURCE = "nvdb_accident"
TYPE_ID = 570
INCLUDE = "{NVDB_INCLUDE}"
DATE_PROPERTY = 5055   # Ulykkesdato

''' + NVDB_PAGINATE_HELPER,
        'rows = collect_nvdb_object_type(TYPE_ID, INCLUDE, {"egenskap": f"{DATE_PROPERTY}>={DATE_FROM}"})',
        WRITE_CELL,
    ],
)


# ---------- 05 nvdb_avalanche_landslide (vegobjekter 445) ----------
render(
    "05_nvdb_avalanche_landslide.py",
    "NVDB avalanche and landslide events",
    "nvdb_avalanche_landslide_bronze",
    "05_nvdb_avalanche_landslide.py",
    "NVDB v4 object type 445 (Skred). Not date-filtered, on purpose: the full history is the point "
    "(docs/plan/02_M1_history_and_reference_data.md T1.3).",
    [
        WIDGETS_BASE.format(table="nvdb_avalanche_landslide_bronze"),
        HTTP_HELPER,
        f'''SOURCE = "nvdb_avalanche_landslide"
TYPE_ID = 445
INCLUDE = "{NVDB_INCLUDE}"

''' + NVDB_PAGINATE_HELPER,
        "rows = collect_nvdb_object_type(TYPE_ID, INCLUDE)",
        WRITE_CELL,
    ],
)


# ---------- 06 nvdb_road_network ----------
render(
    "06_nvdb_road_network.py",
    "NVDB road network segments",
    "nvdb_road_network_bronze",
    "06_nvdb_road_network.py",
    "`vegnett/veglenkesekvenser/segmentert`, the full county road graph -- tens of thousands of "
    "segments, many pages; expect 5 to 15 minutes (docs/plan/02_M1_history_and_reference_data.md T1.3). "
    "srid=25833 so the landed WKT states the horizontal CRS silver uses.",
    [
        WIDGETS_BASE.format(table="nvdb_road_network_bronze"),
        HTTP_HELPER,
        '''SOURCE = "nvdb_road_network"
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
    return out''',
        "rows = collect_nvdb_road_network()",
        WRITE_CELL,
    ],
)


# ---------- 07 nvdb_county ----------
render(
    "07_nvdb_county.py",
    "NVDB county reference list",
    "nvdb_county_bronze",
    "07_nvdb_county.py",
    "`omrader/fylker` -- a single call, no pagination; the response is a plain JSON array at the "
    "document root (not wrapped in `objekter` like the vegobjekter endpoints).",
    [
        WIDGETS_BASE.format(table="nvdb_county_bronze"),
        HTTP_HELPER,
        '''SOURCE = "nvdb_county"
NVDB_BASE = "https://nvdbapiles.atlas.vegvesen.no"
headers = {"Accept": "application/json", "X-Client": "frostsight"}

resp = http_get(f"{NVDB_BASE}/omrader/fylker", headers=headers)
rows = [{"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
         "raw_json_payload": resp.text}]''',
        WRITE_CELL,
    ],
)


DATEX_WFS_BASE = "https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs"

COUNTY_BBOX_HELPER = '''import re

NVDB_BASE = "https://nvdbapiles.atlas.vegvesen.no"
LATLON = re.compile(r"POLYGON\\(\\((.*)\\)\\)")


def county_bbox(county: str) -> str:
    """WFS 2.0 bbox for an NVDB county's kartutsnitt, lat before lon, matching collector/datex.py's
    county_bbox (ADR-0008)."""
    headers = {"Accept": "application/json", "X-Client": "frostsight"}
    resp = http_get(f"{NVDB_BASE}/omrader/fylker", headers=headers, params={"inkluder": "alle", "srid": 4326})
    fylke = next(f for f in resp.json() if str(f["nummer"]) == str(county))
    points = [tuple(map(float, p.split()))
              for p in LATLON.search(fylke["kartutsnitt"]["wkt"]).group(1).split(",")]
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    return f"{min(lats)},{min(lons)},{max(lats)},{max(lons)},urn:ogc:def:crs:EPSG::4326"'''


# ---------- 08 datex_road_weather ----------
render(
    "08_datex_road_weather.py",
    "DATEX road weather snapshot",
    "datex_road_weather_bronze",
    "08_datex_road_weather.py",
    "Open Statens vegvesen WFS, layer `datex_3_1:WeatherSimple_v2`, no auth (ADR-0008, "
    "docs/plan/02_M1_history_and_reference_data.md T1.5). National snapshot (a few hundred sites); "
    "silver filters to the county through the station lookup.",
    [
        WIDGETS_BASE.format(table="datex_road_weather_bronze"),
        HTTP_HELPER,
        f'''SOURCE = "datex_road_weather"
DATEX_WFS_BASE = "{DATEX_WFS_BASE}"
WFS_PARAMS = {{"service": "WFS", "version": "2.0.0", "request": "GetFeature",
              "typeNames": "datex_3_1:WeatherSimple_v2", "outputFormat": "application/json"}}''',
        '''resp = http_get(DATEX_WFS_BASE, params=WFS_PARAMS)
rows = [{"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
         "raw_json_payload": resp.text}]''',
        WRITE_CELL,
    ],
)


# ---------- 09 datex_incidents ----------
render(
    "09_datex_incidents.py",
    "DATEX incident snapshot",
    "datex_incidents_bronze",
    "09_datex_incidents.py",
    "Open Statens vegvesen WFS, layer `datex_3_1:SituationSimple_v2`, no auth, filtered to the county "
    "bbox from NVDB `omrader/fylker` (ADR-0008, docs/plan/02_M1_history_and_reference_data.md T1.5) -- "
    "national is 10 MB, the bbox is under 1 MB.",
    [
        WIDGETS_BASE.format(table="datex_incidents_bronze"),
        HTTP_HELPER,
        f'''SOURCE = "datex_incidents"
DATEX_WFS_BASE = "{DATEX_WFS_BASE}"

''' + COUNTY_BBOX_HELPER,
        '''WFS_PARAMS = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
              "typeNames": "datex_3_1:SituationSimple_v2", "outputFormat": "application/json",
              "srsName": "EPSG:4326", "bbox": county_bbox(COUNTY)}

resp = http_get(DATEX_WFS_BASE, params=WFS_PARAMS)
rows = [{"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
         "raw_json_payload": resp.text}]''',
        WRITE_CELL,
    ],
)


# ---------- 10 datex_site_table ----------
render(
    "10_datex_site_table.py",
    "DATEX measurement site table",
    "datex_site_table_bronze",
    "10_datex_site_table.py",
    "The open WFS has no separate site-table endpoint (ADR-0008): sites are built from the same "
    "`datex_3_1:WeatherSimple_v2` response as `08_datex_road_weather.py` (point geometry, "
    "`REFERENCE_ID`). Changes rarely; sensible to run weekly, not every 10 minutes.",
    [
        WIDGETS_BASE.format(table="datex_site_table_bronze"),
        HTTP_HELPER,
        f'''SOURCE = "datex_site_table"
DATEX_WFS_BASE = "{DATEX_WFS_BASE}"
WFS_PARAMS = {{"service": "WFS", "version": "2.0.0", "request": "GetFeature",
              "typeNames": "datex_3_1:WeatherSimple_v2", "outputFormat": "application/json"}}''',
        '''resp = http_get(DATEX_WFS_BASE, params=WFS_PARAMS)
rows = [{"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
         "raw_json_payload": resp.text}]''',
        WRITE_CELL,
    ],
)


FROST_CREDS_CHECK = '''frost_client_id = get_secret("frost_client_id")
if not frost_client_id:
    print(f"{SOURCE}: secret 'frost_client_id' not set in scope '{SECRET_SCOPE}'; skipping this run")
    dbutils.notebook.exit(f"skipped: {SOURCE} credentials not configured")
auth = (frost_client_id, "")   # Frost: client id is the basic-auth username, password is empty'''


# ---------- 11 frost_station_source ----------
render(
    "11_frost_station_source.py",
    "MET Frost station sources",
    "frost_station_source_bronze",
    "11_frost_station_source.py",
    "MET Frost `/sources/v0.jsonld`, Statens vegvesen stations for the county "
    "(docs/plan/02_M1_history_and_reference_data.md T1.4). Skips the run when `frost_client_id` is "
    "missing.",
    [
        WIDGETS_WITH_SECRETS.format(table="frost_station_source_bronze"),
        HTTP_HELPER,
        '''SOURCE = "frost_station_source"
FROST_BASE = "https://frost.met.no"
COUNTY_NAMES = {"55": "Troms", "34": "Innlandet"}   # Frost documents county as a name, not a number

''' + FROST_CREDS_CHECK,
        '''resp = http_get(f"{FROST_BASE}/sources/v0.jsonld", auth=auth,
                 params={"stationholder": "STATENS VEGVESEN", "county": COUNTY_NAMES.get(COUNTY, COUNTY)})
rows = [{"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
         "raw_json_payload": resp.text}]''',
        WRITE_CELL,
    ],
)


# ---------- 12 frost_observation_history ----------
render(
    "12_frost_observation_history.py",
    "MET Frost historical observations",
    "frost_observation_history_bronze",
    "12_frost_observation_history.py",
    "MET Frost `/observations/v0.jsonld`, one call per station per calendar month in `[date_from, "
    "date_to)` (docs/plan/02_M1_history_and_reference_data.md T1.4). About 30 stations times 5 months "
    "is up to 150 requests; Frost allows a few requests per second and the retry session backs off on "
    "429. A 412 (\"no data found for this combination\") is skipped, not an error. Skips the whole run "
    "when `frost_client_id` is missing.",
    [
        WIDGETS_WITH_SECRETS.format(table="frost_observation_history_bronze") + '''
dbutils.widgets.text("date_from", "2025-11-01", "History window start (YYYY-MM-DD)")
dbutils.widgets.text("date_to", "2026-04-01", "History window end (YYYY-MM-DD), exclusive")
DATE_FROM = dbutils.widgets.get("date_from")
DATE_TO = dbutils.widgets.get("date_to")''',
        HTTP_HELPER,
        '''SOURCE = "frost_observation_history"
FROST_BASE = "https://frost.met.no"
COUNTY_NAMES = {"55": "Troms", "34": "Innlandet"}
ELEMENTS = ["air_temperature", "road_surface_temperature", "dew_point_temperature",
            "relative_humidity", "wind_speed", "wind_from_direction", "sum(precipitation_amount PT10M)"]

''' + FROST_CREDS_CHECK,
        '''import datetime as dt


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
print(f"{len(source_ids)} Frost sources in county {COUNTY}")''',
        '''start = dt.date.fromisoformat(DATE_FROM)
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
                    "raw_json_payload": resp.text})''',
        WRITE_CELL,
    ],
)


STATION_POINTS_HELPER = '''import json
import re

STATIONS_TABLE = f"{CATALOG}.bronze.nvdb_weather_station_location_bronze"
STATION_NUMBER_PROPERTY = 3591   # Maalestasjonsnummer
WKT_POINT = re.compile(r"POINT\\s*Z?\\s*\\(\\s*([-\\d.]+)\\s+([-\\d.]+)")

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
print(f"{len(points)} station points from {STATIONS_TABLE}")'''


# ---------- 13 open_meteo_elevation ----------
render(
    "13_open_meteo_elevation.py",
    "Open-Meteo elevation",
    "open_meteo_elevation_bronze",
    "13_open_meteo_elevation.py",
    "Fallback for Kartverket, which was unreachable at verification (docs/plan/02_M1_history_and_"
    "reference_data.md T1.6). Depends on `nvdb_weather_station_location_bronze` already existing "
    "(run `01_nvdb_weather_station_location.py` first) to get the station points to query; batches "
    "of up to 100 points per call, the documented Open-Meteo limit.",
    [
        "# MAGIC %pip install pyproj",
        WIDGETS_BASE.format(table="open_meteo_elevation_bronze"),
        HTTP_HELPER,
        '''from pyproj import Transformer

SOURCE = "open_meteo_elevation"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/elevation"
to_wgs84 = Transformer.from_crs("EPSG:25833", "EPSG:4326", always_xy=True)

''' + STATION_POINTS_HELPER,
        '''rows = []
for i in range(0, len(points), 100):
    batch = points[i : i + 100]
    params = {"latitude": ",".join(str(p["lat"]) for p in batch),
              "longitude": ",".join(str(p["lon"]) for p in batch)}
    resp = http_get(OPEN_METEO_URL, params=params)
    rows.append({"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
                "raw_json_payload": resp.text})''',
        WRITE_CELL,
    ],
)


# ---------- 14 met_locationforecast ----------
render(
    "14_met_locationforecast.py",
    "MET Locationforecast",
    "met_locationforecast_bronze",
    "14_met_locationforecast.py",
    "Post-MVP batch source (`docs/plan/00_README.md` section 5). One call per road-weather station "
    "(same station points as the elevation notebook), with a courtesy delay between calls to stay "
    "inside MET's fair-use limits. Depends on `nvdb_weather_station_location_bronze` already existing.",
    [
        "# MAGIC %pip install pyproj",
        WIDGETS_BASE.format(table="met_locationforecast_bronze"),
        HTTP_HELPER,
        '''from pyproj import Transformer

SOURCE = "met_locationforecast"
MET_FORECAST_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"
to_wgs84 = Transformer.from_crs("EPSG:25833", "EPSG:4326", always_xy=True)

''' + STATION_POINTS_HELPER,
        '''rows = []
for p in points:
    params = {"lat": p["lat"], "lon": p["lon"]}
    resp = http_get(MET_FORECAST_URL, params=params)
    rows.append({"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
                "station_id": p["station_id"], "raw_json_payload": resp.text})
    time.sleep(0.2)''',
        WRITE_CELL,
    ],
)


# ---------- 15 trafikkdata ----------
render(
    "15_trafikkdata.py",
    "Statens vegvesen trafikkdata",
    "trafikkdata_bronze",
    "15_trafikkdata.py",
    "Post-MVP, cut from MVP scope (`docs/plan/00_README.md` section 5). GraphQL, no auth. Lands the "
    "county's traffic registration points.",
    [
        WIDGETS_BASE.format(table="trafikkdata_bronze"),
        HTTP_HELPER,
        '''SOURCE = "trafikkdata"
TRAFIKKDATA_URL = "https://trafikkdata-api.atlas.vegvesen.no/"
QUERY = """
query($county: PositiveInt!) {
  trafficRegistrationPoints(searchQuery: {countyNumbers: [$county]}) {
    id name trafficRegistrationType
  }
}"""''',
        '''resp = http_post(TRAFIKKDATA_URL, json={"query": QUERY, "variables": {"county": int(COUNTY)}})
rows = [{"source": SOURCE, "request_url": resp.url, "http_status": resp.status_code,
         "raw_json_payload": resp.text}]''',
        WRITE_CELL,
    ],
)

print("generated", len(list(OUT.glob("*.py"))) - 1, "bronze notebook files")
