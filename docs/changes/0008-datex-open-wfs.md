# Change 0008: DATEX road weather and incidents from the open WFS

- Decision: [ADR-0008](../adr/0008-datex-data-from-open-wfs.md). Evidence: `docs/source-verification.md`.
- For: the DATEX owner (Shawon, M0 T0.4/T0.5/T0.8, M1 T1.5/T1.7, M2 T2.5). Reviewer: Safiul.
- Line numbers below are as of the commit that added this file. Find by the quoted text if they have moved.

## What changes, what stays

| | Before | After |
|---|---|---|
| Endpoint | `datex-server-get-v3-1.atlas.vegvesen.no/datexapi/<publication>/pullsnapshotdata` | `ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs`, layers `WeatherSimple_v2` and `SituationSimple_v2` |
| Auth | Basic Auth, account from the access form, fixed IP or DNS name | none |
| Secrets | `DATEX_USER`, `DATEX_PASSWORD` | none |
| Response | DATEX II XML, namespace-agnostic parsing | GeoJSON with flat `properties` |
| Raw landing | `road_weather_xml/<ts>.xml`, `road_incidents_xml/<ts>.xml` | `road_weather_raw/<ts>.geojson`, `road_incidents_raw/<ts>.geojson` |
| Scope | national snapshots | weather national (0.4 MB); incidents filtered by a county `bbox` (0.8 MB instead of 10 MB) |
| `station_ref` | parsed from the site id, maybe | `REFERENCE_ID`, which is the NVDB `Målestasjonsnummer` (23 of 24 Troms stations on 2026-10-07) |
| `datex_sites` | `GetMeasurementWeatherSiteTable` | built from the `WeatherSimple_v2` response (point geometry) |
| `precipitation_type` | measured | `PRECIPITATION_TYPE` if present (null everywhere on 2026-10-07), else `precip_type(intensity, air)` |
| `road_surface_state` | measured | `null`, as for Frost replay rows |
| Collector host | static-IP host if the fixed IP is enforced | GitHub Actions is enough |

**Unchanged:** contract v1 (both line shapes, `schema_version: "1"`), the landing folders
`road_weather/`, `road_incidents/` and `datex_sites/`, everything in bronze, silver and gold, dashboards, and the
cadence (10 min weather, 30 min incidents). Source names and table comments keep saying "DATEX": it is still
the DATEX publication, delivered differently.

## Already done in the commit that added this file

- `config/sources.yml`: `datex_road_weather` and `datex_incidents` point at the WFS with `params`, `scope`,
  `auth: none`, no `secret`, and landing `*_raw`. This file is the source of truth for the code below.
- `docs/source-verification.md`: findings, tested endpoints, field lists, next actions.
- `docs/adr/0008-datex-data-from-open-wfs.md` (new) and an amendment note on ADR-0004.
- `.claude/rules/collector.md`: the `*_xml` rule now says `*_raw`.

Everything below is for you to change.

## 1. Plan conventions: `docs/plan/00_README.md`

| Line | Find | Change to |
|---|---|---|
| 48 | `Runs outside: GitHub Actions cron, or a static-IP host for DATEX` | `Runs outside: GitHub Actions cron (no fixed IP needed, ADR-0008)` |
| 133 | `datex.py   road weather 10-min and incidents, basic auth` | `datex.py   road weather and incidents from the open DATEX WFS, no auth` |
| 156 | `cron: run collector for sources that do not need a fixed IP` | `cron: run the collector (road weather, incidents; NVDB weekly)` |
| 160 | `docs/adr/ ... 0001 to 0004 are in the scaffold, 0005 to 0007 come from M3` | add `, 0008 DATEX from the open WFS`; add a layout line `docs/changes/   step-by-step change lists for an ADR` |
| 171 | `road_weather_xml`, `road_incidents_xml` | `road_weather_raw`, `road_incidents_raw` |
| 186 | `joined to DATEX or Frost ids through the lookup` | `equal to the DATEX REFERENCE_ID; joined to Frost ids through the lookup` |
| 198 | DATEX II road weather row | `` `https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs` layer `datex_3_1:WeatherSimple_v2` `` · `none` · `10 min` · `Yes` |
| 199 | DATEX II incidents row | `same WFS, layer datex_3_1:SituationSimple_v2 with a county bbox` · `none` · `30 min` · `Yes` |

## 2. M0: `docs/plan/01_M0_accounts_and_sources.md`

**T0.3, line 136.** Drop `, static-IP host` from the `collector` extra comment.

**T0.4 Data access registrations (lines 191 to 255).**
- Line 192, Why: only MET Frost needs credentials now; say DATEX is open (ADR-0008).
- Delete steps 1 and 2 (the DATEX form and the fixed-IP email, lines 196 to 210) and renumber the rest.
- Delete `DATEX_USER=` and `DATEX_PASSWORD=` from the `.env` block (219 to 220), the
  `${{ secrets.DATEX_USER }}` note (227) and the two `put-secret ... datex_*` lines (232 to 233).
- Lines 243 to 244: change the example key from `datex_user` to `frost_client_id`.
- Line 245: `DATEX and Frost credentials` becomes `Frost credentials`.
- Line 247, Expect: drop "DATEX form submitted, email sent".
- Lines 251 to 252, If it fails: delete the two DATEX rows.

**T0.5 Source verification script (lines 257 to 406).**
- Line 285: `DATEX = "https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs"`.
- Lines 346 to 352: replace `check_datex` with a no-auth check:
  ```python
  def check_datex() -> list[Check]:
      out = []
      for name, layer in {"datex_road_weather": "WeatherSimple_v2", "datex_situations": "SituationSimple_v2"}.items():
          params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
                    "typeNames": f"datex_3_1:{layer}", "outputFormat": "application/json", "count": "5"}
          r = _get(DATEX, params=params)
          ok = r.ok and r.content.lstrip().startswith(b"{") and bool(r.json().get("features"))
          out.append(Check(name, "OK" if ok else "FAIL", f"{r.status_code} bytes={len(r.content)}"))
      return out
  ```
- Line 384: delete "Re-run after the DATEX account arrives."
- Lines 396 to 397, expected output: `datex_road_weather OK ... 200 bytes≈5000`, `datex_situations OK ... 200 bytes≈20000`.
- Line 406: replace the 401 row with "`400` from the WFS: wrong `typeNames` or `outputFormat`; open
  `?service=wfs&request=GetCapabilities` and check the layer list."

**T0.8 Capture fixtures, lines 483 to 491.** Replace the two `curl --user` lines and the trimming note with:
```bash
WFS="https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json"
curl -s "$WFS&typeNames=datex_3_1:WeatherSimple_v2&CQL_FILTER=COUNTY%3D%27Troms%27&count=3" > tests/fixtures/datex_weather_simple.geojson
curl -s "$WFS&typeNames=datex_3_1:SituationSimple_v2&srsName=EPSG:4326&bbox=68.2,15.5,70.8,23.3,urn:ogc:def:crs:EPSG::4326&count=3" > tests/fixtures/datex_situations_simple.geojson
```
Both are under 50 KB, so no trimming. Check that the weather fixture has at least one station with
`ROAD_SURFACE_TEMPERATURE` not null; if not, raise `count`.

**T0.9 M0 gate, lines 516, 523 to 524, 532.** The DATEX row becomes "DATEX WFS: OK" from the T0.5 output.
Delete the "waiting for at most two more weeks" exception and the "credentials exist, or the form and the
fixed-IP email are sent" line.

## 3. M1: `docs/plan/02_M1_history_and_reference_data.md`

**Landing table, lines 21 to 25.**
| Line | Change |
|---|---|
| 21 | `road_weather/`: "flat JSON lines, contract v1"; drop "once credentials exist" |
| 22 | `road_weather_raw/` · `<ts>.geojson` · "the WFS response as received; never read by the pipeline" |
| 24 | `road_incidents_raw/` · `<ts>.geojson` · "the WFS response as received" |
| 25 | `datex_sites/`: "built from the `WeatherSimple_v2` response; `site_id` = `REFERENCE_ID`" |

**Line 45**, task table: T1.5 title `datex.py: contract v1 from the open WFS`, dependency `none`.

**Lines 110 to 111**, `mkdirs` loop: `road_weather_xml` → `road_weather_raw`, `road_incidents_xml` → `road_incidents_raw`.

**Lines 134 and 141**: drop "on a static-IP host" from both sentences.

**T1.2 `common.py`.** Add `precip_type` at the end of the module, so the collector and the replay harness
share one approximation:
```python
def precip_type(amount: float | None, air: float | None) -> str:
    """Approximate precipitation type from an amount (any unit; only zero or positive matters) and air temperature.

    Used where the source has no measured type: Frost history (replay) and the WFS weather layer (ADR-0008).
    """
    if amount is None:
        return "unknown"
    if amount <= 0:
        return "none"
    if air is None:
        return "unknown"
    return "snow" if air <= 0.5 else "sleet" if air <= 2.0 else "rain"
```

**T1.2 `run.py`, lines 285 to 321.**
- Line 286: `SECRET_KEYS = {"FROST_CLIENT_ID": "frost_client_id"}`.
- Lines 318 to 321:
  ```python
      if source in ("road_weather", "road_incidents"):
          return datex.collect(source, a.target, a.county)
      if source == "datex_sites":
          return datex.collect_sites(a.target, a.county)
  ```
- Line 270, docstring example: add `--county 55` to the `road_weather road_incidents` line.

**T1.2 `config/sources.yml` block, lines 363 to 374.** Replace the two DATEX entries with the
`datex_road_weather` and `datex_incidents` entries from the repo's `config/sources.yml`. The repo file is the
source of truth. Its key is `datex_incidents`, not `datex_situations`. `collector/metadata.py` writes `params`
as a nested object, which bronze reads as a struct; that is fine.

**T1.5, lines 750 to 952: replace the task body.** Keep the heading pattern and the contract v1 block
(lines 755 to 771) unchanged. New Why:

> Bronze (M4) reads flat JSON lines, so the collector maps the WFS GeoJSON to contract v1. The raw
> response is kept beside it. No credentials (ADR-0008). The 10-minute cron starts at M2; M1 lands one pair
> by hand.

Step 1, `collector/datex.py`. This code was run against the live service on 2026-10-07 and landed 468
weather lines, 167 Troms incident lines and 468 sites:
```python
"""DATEX from the open Statens vegvesen WFS (ADR-0008): raw GeoJSON as-is, plus contract v1 JSON lines."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import yaml

from collector.common import deliver, landing_path, precip_type, session, utc_now, write_bytes, write_jsonl

log = logging.getLogger("collector.datex")
CONFIG = Path(__file__).resolve().parents[1] / "config" / "sources.yml"
CONFIG_KEYS = {"road_weather": "datex_road_weather", "road_incidents": "datex_incidents"}
SCHEMA_VERSION = "1"
# SituationSimple_v2 SITUATION_TYPE -> contract incident_type; values seen on 2026-10-07, extend on new ones
INCIDENT_TYPES = {
    "RoadOrCarriagewayOrLaneManagement": "CLOSURE",
    "Accident": "ACCIDENT",
    "MaintenanceWorks": "ROADWORK",
    "ConstructionWorks": "ROADWORK",
    "PoorEnvironmentConditions": "WEATHER",
    "WeatherRelatedRoadConditions": "WEATHER",
    "GeneralObstruction": "OBSTRUCTION",
    "AnimalPresenceObstruction": "OBSTRUCTION",
    "VehicleObstruction": "OBSTRUCTION",
    "EnvironmentalObstruction": "OBSTRUCTION",
    "InfrastructureDamageObstruction": "OBSTRUCTION",
}
SEVERITY = {
    "highest": "HIGH",
    "high": "HIGH",
    "medium": "MEDIUM",
    "low": "LOW",
    "lowest": "LOW",
    "none": "LOW",
}
# WeatherSimple_v2 property -> contract field (numeric)
WEATHER_VALUES = {
    "AIR_TEMPERATURE": "air_temperature",
    "ROAD_SURFACE_TEMPERATURE": "road_surface_temperature",
    "DEW_POINT_TEMPERATURE": "dew_point",
    "RELATIVE_HUMIDITY": "humidity",
    "PRECIPITATION_INTENSITY": "precipitation_intensity",
    "WIND_SPEED": "wind_speed",
    "WIND_DIRECTION_BEARING": "wind_direction",
}
LATLON = re.compile(r"POLYGON\(\((.*)\)\)")


def config() -> dict:
    return yaml.safe_load(CONFIG.read_text(encoding="utf-8"))["sources"]


def as_float(value: object) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def to_utc(value: str | None) -> str | None:
    """ISO time with offset (WFS sends local time) -> UTC ...Z."""
    if not value:
        return None
    return datetime.fromisoformat(value).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def county_bbox(county: int) -> str:
    """WFS 2.0 bbox for an NVDB county, from its kartutsnitt (lat first in EPSG:4326)."""
    nvdb = config()["nvdb"]
    r = session(headers=nvdb.get("headers")).get(
        f"{nvdb['url']}/omrader/fylker", params={"inkluder": "alle", "srid": 4326}, timeout=60
    )
    r.raise_for_status()
    fylke = next(f for f in r.json() if str(f["nummer"]) == str(county))
    points = [
        tuple(map(float, p.split())) for p in LATLON.search(fylke["kartutsnitt"]["wkt"]).group(1).split(",")
    ]
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    return f"{min(lats)},{min(lons)},{max(lats)},{max(lons)},urn:ogc:def:crs:EPSG::4326"


def fetch(source: str, county: int) -> bytes:
    spec = config()[CONFIG_KEYS[source]]
    params = dict(spec["params"])
    if spec.get("scope") == "county_bbox":
        params["bbox"] = county_bbox(county)
    r = session().get(spec["url"], params=params, timeout=120)
    r.raise_for_status()
    if not r.content.lstrip().startswith(b"{"):
        raise RuntimeError(f"{source}: response is not GeoJSON: {r.content[:80]!r}")
    return r.content


def features(body: bytes) -> list[dict]:
    return json.loads(body)["features"]


def parse_weather(body: bytes) -> Iterator[dict]:
    """One line per station: the latest reading in this snapshot."""
    for f in features(body):
        p = f["properties"]
        ref = p.get("REFERENCE_ID")
        t = to_utc(p.get("MEASUREMENT_TIME"))
        row = {
            "schema_version": SCHEMA_VERSION,
            "source_event_id": f"SVV-{ref}-{t}",
            "station_ref": ref,
            "site_id": ref,
            "measurement_time": t,
        }
        row.update({field: as_float(p.get(prop)) for prop, field in WEATHER_VALUES.items()})
        measured = (p.get("PRECIPITATION_TYPE") or "").strip().lower()
        row["precipitation_type"] = measured or precip_type(
            row["precipitation_intensity"], row["air_temperature"]
        )
        row["road_surface_state"] = None  # not in WeatherSimple_v2 (ADR-0008)
        row.update({"temperature_unit": "C", "precipitation_unit": "mm/h", "wind_speed_unit": "m/s"})
        yield row


def parse_situations(body: bytes, snapshot_time: str) -> Iterator[dict]:
    """One line per record version; the WFS repeats a record once per validity period, so periods merge."""
    seen: dict[str, dict] = {}
    for f in features(body):
        p = f["properties"]
        key = f"{p['RECORD_ID']}:{p['VERSION']}"
        start, end = to_utc(p.get("START_TIME")), to_utc(p.get("END_TIME"))
        if key in seen:  # widen to cover every period
            row = seen[key]
            row["start_time"] = min(filter(None, (row["start_time"], start)), default=None)
            row["end_time"] = None if row["end_time"] is None or end is None else max(row["end_time"], end)
            continue
        secondary = (p.get("SECONDARY_TYPES") or "").split(",")
        kind = (
            "CLOSURE" if "roadClosed" in secondary else INCIDENT_TYPES.get(p.get("SITUATION_TYPE"), "OTHER")
        )
        seen[key] = {
            "schema_version": SCHEMA_VERSION,
            "source_event_id": key,
            "incident_id": p["RECORD_ID"],
            "version": p.get("VERSION"),
            "incident_type": kind,
            "severity": SEVERITY.get((p.get("SEVERITY") or "").lower(), "UNKNOWN"),
            "road_ref": p.get("ROAD_NUMBER"),
            "start_time": start,
            "end_time": end,
            "description": p.get("DESCRIPTION"),
            "lat": as_float(p.get("COORDINATES_FOR_DISPLAY_LATITUDE")),
            "lon": as_float(p.get("COORDINATES_FOR_DISPLAY_LONGITUDE")),
            "snapshot_time": snapshot_time,
        }
    yield from seen.values()


def parse_sites(body: bytes) -> Iterator[dict]:
    for f in features(body):
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        yield {
            "site_id": p.get("REFERENCE_ID"),
            "name": p.get("LOCATION_DESCRIPTION"),
            "lat": lat,
            "lon": lon,
        }


def collect(source: str, target: str, county: int, ts: datetime | None = None) -> list[str]:
    """Land <source>_raw/<ts>.geojson (raw) and <source>/<ts>.jsonl (contract v1)."""
    ts = ts or utc_now()
    body = fetch(source, county)
    raw_rel = landing_path(f"{source}_raw", ts, "geojson")
    out = [deliver(write_bytes(raw_rel, body), raw_rel, target)]
    rows = (
        parse_weather(body)
        if source == "road_weather"
        else parse_situations(body, ts.strftime("%Y-%m-%dT%H:%M:%SZ"))
    )
    rel = landing_path(source, ts, "jsonl")
    path, n = write_jsonl(rel, rows)
    log.info("%s: %d bytes geojson, %d lines", source, len(body), n)
    if n == 0:
        raise RuntimeError(
            f"{source}: parsed zero records; check the layer and property names against {raw_rel}"
        )
    out.append(deliver(path, rel, target))
    return out


def collect_sites(target: str, county: int) -> list[str]:
    ts = utc_now()
    body = fetch("road_weather", county)
    rel = landing_path("datex_sites", ts, "jsonl")
    path, n = write_jsonl(rel, parse_sites(body))
    log.info("datex_sites: %d sites", n)
    return [deliver(path, rel, target)]
```

Step 2, run all three. No `.env` is needed for these sources:
```bash
uv run python -m collector.run --source road_weather road_incidents datex_sites --county 55 --target free
```

Step 3, open the landed `road_weather_raw/...geojson` and confirm:
- `REFERENCE_ID` still matches NVDB `Målestasjonsnummer` (`nvdb_stations`) for the Troms stations. If it stops
  matching, leave `station_ref` null and resolve through `silver.road_weather_stations.datex_site_id` (M4 T4.4),
  as the old step 3 described.
- Whether `PRECIPITATION_TYPE` has started carrying values. Note the answer in T1.7.
- Any `SITUATION_TYPE` that falls to `OTHER` and should map to a contract type. Add it to `INCIDENT_TYPES`.

Step 4, unit tests on the M0 fixtures, added to T1.9's test file:
`parse_weather(open("tests/fixtures/datex_weather_simple.geojson","rb").read())` yields rows with
`station_ref`, a UTC `measurement_time` ending in `Z` and at least one temperature. `parse_situations` on
`datex_situations_simple.geojson` yields rows with `incident_id`, `version` and unique `source_event_id`. Also
add a two-feature inline case with the same `RECORD_ID` and `VERSION` and different periods. It must yield one
row with the earliest start and the latest end.

New Expect:
- `road_weather_raw/2026/<mm>/<dd>/<ts>.geojson` of about 0.4 MB.
- `road_weather/.../<ts>.jsonl` with one line per station nationally, about 470. Silver filters to the county.
- `road_incidents_raw/` of about 0.8 MB and `road_incidents/` with about 150 to 170 lines for the Troms bbox.
  The bbox also catches a few situations just over the border; silver drops them when it maps to segments.
- `datex_sites/.../<ts>.jsonl` with one line per station.

New If it fails:
- `400`: wrong `typeNames` or bbox axis order. With the `urn:` CRS the order is lat,lon.
- `parsed zero records`: the layer was renamed or emptied. Check `GetCapabilities`. The raw file was landed
  before parsing.
- A station with all temperatures null: wind-only stations exist (for example `3001052`). That is expected,
  and silver handles nulls.

**T1.7 contract table, lines 1080 to 1089.** Replace the "DATEX II (fill from the landed XML)" table with:

| Dataset | WFS property | Contract field | Notes |
|---|---|---|---|
| road_weather | `REFERENCE_ID` | `site_id`, `station_ref` | equals NVDB `Målestasjonsnummer` |
| road_weather | `MEASUREMENT_TIME` | `measurement_time` | local time with offset; collector converts to UTC `Z` |
| road_weather | `AIR_TEMPERATURE`, `ROAD_SURFACE_TEMPERATURE`, `DEW_POINT_TEMPERATURE`, `RELATIVE_HUMIDITY`, `PRECIPITATION_INTENSITY`, `WIND_SPEED`, `WIND_DIRECTION_BEARING` | the seven numeric fields | °C, %, mm/h, m/s, degrees |
| road_weather | `PRECIPITATION_TYPE` | `precipitation_type` | null on 2026-10-07; fallback `precip_type(intensity, air)` |
| road_weather | none | `road_surface_state` | always null (ADR-0008) |
| road_incidents | `RECORD_ID`, `VERSION` | `incident_id`, `version`, `source_event_id` = `RECORD_ID:VERSION` | periods of one record merged |
| road_incidents | `SITUATION_TYPE`, `SECONDARY_TYPES` | `incident_type` | `roadClosed` in secondary types wins as `CLOSURE` |
| road_incidents | `SEVERITY`, `ROAD_NUMBER`, `START_TIME`, `END_TIME`, `DESCRIPTION`, `COORDINATES_FOR_DISPLAY_LATITUDE`/`_LONGITUDE` | `severity`, `road_ref`, `start_time`, `end_time`, `description`, `lat`, `lon` | `none` severity maps to `LOW` |
| datex_sites | `REFERENCE_ID`, `LOCATION_DESCRIPTION`, point geometry | `site_id`, `name`, `lat`, `lon` | geometry is lon,lat |

**Lines 1189, 1206 to 1208, 1217, 1221.**
- 1189: the test names now take the `.geojson` fixtures.
- 1206: `road_weather_raw + road_incidents_raw`, about 1.2 MB per pair; retention deletes raw older than 30 days.
- 1208: the growth line is the same, at a smaller size.
- 1217: drop "(credentials permitting)".
- 1221: replace with "ADR-0008 recorded (DATEX from the open WFS)".

## 4. M2: `docs/plan/03_M2_foundation.md`

**T2.2, line 185:** `pull_datex` stays. Add `"--county", "55"` to its parameters to match the CLI examples.

**T2.5 Collector deployment, lines 566 to 672.**
- Lines 596 to 597: delete the `DATEX_USER` and `DATEX_PASSWORD` env lines from `collector.yml`.
- Lines 608 to 612: keep the Actions budget paragraph. The static-IP host is now only a way to poll every 10
  minutes without spending Actions minutes, not an access requirement.
- Line 613: reword the heading to "Static-IP or always-on host (optional): for 10-minute polling beyond the
  Actions budget". Delete "needed if Statens vegvesen enforces the fixed-IP field".
- Line 622: systemd description: `FrostSight collector: DATEX WFS road weather and incidents to the landing volume`.
- Line 655: `road_weather_xml/` by one `.xml` → `road_weather_raw/` by one `.geojson`.
- Lines 662 to 663: delete the fixed-IP sentence about the `aws` workspace.
- Line 670: replace the 401 row with "`400` from the WFS: see T1.5 If it fails".
- Line 672: `parsed zero records`: point at `road_weather_raw/` instead of the raw XML.

**T2.6 replay harness, line 796:** delete the local `precip_type` and use
`from collector.common import precip_type`. The behaviour is unchanged.

**Line 1080, gate notes:** drop "fixed IP enforced with no host" from the list of reasons.

## 5. M3, M4 and M7

| File | Line | Change |
|---|---|---|
| `04_M3_design.md` | 45 | `source_station_ref`: "contract `site_id`: the DATEX `REFERENCE_ID` (NVDB station number) or the Frost source id" |
| `04_M3_design.md` | 98 | `datex_site_id` stays; note it is usually equal to `station_id` now |
| `05_M4_bronze_and_silver.md` | 51 | "DATEX via the open WFS: the collector maps the GeoJSON to JSON lines (contract v1). The raw GeoJSON is kept under `raw/road_weather_raw/` and `raw/road_incidents_raw/`." |
| `05_M4_bronze_and_silver.md` | 305, 316 | table comments: "DATEX (open WFS) flattened to JSON lines" |
| `08_M7_hardening_and_demo.md` | 335 | delete "VM cron if the DATEX fixed IP is enforced" |
| `08_M7_hardening_and_demo.md` | 338 | replace "HTTP 401 from DATEX (account expired; renew form)" with "HTTP 400 or zero features from the WFS (layer renamed; check GetCapabilities)" |

`09_MVP_review.md` is a review log. Do not rewrite its rows. Add one line under the open questions saying that
lines 93 and 126 to 127 (does the site id carry the station number) are answered by ADR-0008: `REFERENCE_ID`
is the station number.

## 6. Overview docs

| File | Line | Change |
|---|---|---|
| `docs/architecture.md` | 84 | remove the `Static-IP host, if DATEX needs it` node and its edges |
| `docs/architecture.md` | 122 | row 1: "HTTPS GET, WFS GeoJSON, mapped to JSON lines" · "none (open WFS, ADR-0008)" |
| `docs/architecture.md` | 132 | secrets row: drop "DATEX account" |
| `docs/architecture.html` | same nodes and rows | mirror the `architecture.md` edits |
| `docs/platform-targets.md` | 13, 71, 97, 98, 156, 158 | drop the static-IP VM cost and the DATEX account row; M2 row: "GitHub Actions runs the collector"; actions: "Confirm NLOD covers the DATEX WFS" instead of the form |
| `docs/adr/0001-product-scope.md` | 13 | "MET Frost needs a free account; DATEX is open through the WFS (ADR-0008)" |

## 7. Done when

- [ ] `uv run python -m collector.run --source road_weather road_incidents datex_sites --county 55 --target local`
      lands five files under `data/landing/` with no environment variables set.
- [ ] `uv run pytest` passes with the two new fixtures and the period-merge test.
- [ ] `grep -rn "DATEX_USER\|DATEX_PASSWORD\|_xml/\|pullsnapshotdata" docs/plan collector .github` returns only
      `09_MVP_review.md` history rows.
- [ ] Statens vegvesen has confirmed NLOD for the WFS, or the question is logged with a date in the M0 gate notes.
