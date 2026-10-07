"""Fetch real Troms roads and road-weather stations from NVDB and write nvdb_seed.sql for the mock dashboards.

A developer step run once on a laptop, like the collector: pipelines and jobs still never call NVDB.
- Roads: the main carriageway of every E, R and F road with a station, merged per road, strekning and
  delstrekning, simplified, and sampled every POINT_M so a point map draws them (seed_road_points); the
  merged lines feed a path map.
- Stations: the real NVDB object type 153 in the county (decommissioned ones left out), each mapped to its
  nearest main-road segment on its own road, the way silver.station_segment_lookup will be (seed_stations,
  seed_segments). Readings stay synthetic; the real elevation picks the mock climate, and a station marked
  temporarily out of service is the stale one.
- Incidents: six mock incidents placed on chosen stations (seed_incidents).

Run: uv run --with shapely python tools/mock_dashboards/fetch_nvdb.py
Data: Statens vegvesen, NVDB, NLOD.
"""

from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.request
from collections import defaultdict
from http.client import IncompleteRead
from pathlib import Path

import shapely
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge
from shapely.strtree import STRtree

BASE = "https://nvdbapiles.atlas.vegvesen.no"
HEADERS = {"X-Client": "frostsight", "Accept": "application/json"}
COUNTY = 55
POINT_M = 300  # spacing of the grey road points
SIMPLIFY_DEG = 0.0002  # about 20 m
HERE = Path(__file__).resolve().parent
OUT_SQL = HERE / "nvdb_seed.sql"
OUT_META = HERE / "nvdb_seed.json"
# Mock incidents: type, severity, start and end age in minutes (end None = open), description, station climate
INCIDENTS = [
    (
        "CLOSURE",
        "HIGH",
        95,
        None,
        "Road closed: snowdrift and stuck vehicles. Column driving from 08:00.",
        "mountain",
    ),
    ("ACCIDENT", "MEDIUM", 80, None, "Vehicle off the road, one lane open.", "inland"),
    ("WEATHER", "MEDIUM", 170, None, "Slippery road, gritting in progress.", "fjord"),
    ("OBSTRUCTION", "LOW", 380, 300, "Fallen tree cleared from the road.", "coast"),
    ("ROADWORK", "LOW", 1720, 1210, "Night roadwork, alternating one-lane traffic.", "fjord"),
    ("ACCIDENT", "HIGH", 2210, 2080, "Collision, road reopened.", "coast"),
]


def get(url: str) -> dict:
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except (IncompleteRead, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print(f"  retry {attempt + 1} after {type(e).__name__}")
            time.sleep(2 + 3 * attempt)
    raise RuntimeError(f"NVDB did not answer: {url}")


def pages(url: str) -> list[dict]:
    out: list[dict] = []
    while url:
        d = get(url)
        out.extend(d["objekter"])
        meta = d.get("metadata", {})
        url = meta.get("neste", {}).get("href") if meta.get("returnert", len(d["objekter"])) else None
    return out


def lonlat(wkt: str) -> shapely.Geometry:
    """NVDB returns srid=4326 WKT as 'lat lon [z]'; swap to lon lat and drop Z."""
    g = shapely.force_2d(shapely.from_wkt(wkt))
    return shapely.transform(g, lambda xy: xy[:, ::-1])


def length_m(line: LineString) -> float:
    total = 0.0
    for (x1, y1), (x2, y2) in zip(line.coords, list(line.coords)[1:], strict=False):
        total += math.hypot((x2 - x1) * 111320 * math.cos(math.radians((y1 + y2) / 2)), (y2 - y1) * 110570)
    return total


def sql_str(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def inserts(table: str, rows: list[str], chunk: int) -> list[str]:
    out = []
    for i in range(0, len(rows), chunk):
        out += [f"INSERT INTO frostsight.mock.{table} VALUES", ",\n".join(rows[i : i + chunk]) + ";", ""]
    return out


def climate(elevation_m: float, lat: float) -> str:
    """Mock climate from the real station elevation: higher is colder; low and far south is mild."""
    if elevation_m >= 300:
        return "mountain"
    if elevation_m >= 150:
        return "inland"
    if lat < 68.8:
        return "warm"
    return "coast" if elevation_m < 15 else "fjord"


def fetch_stations() -> list[dict]:
    url = f"{BASE}/vegobjekter/api/v4/vegobjekter/153?fylke={COUNTY}&srid=4326&inkluder=egenskaper,lokasjon"
    stations = []
    for o in pages(url):
        props = {e["navn"]: e.get("verdi") for e in o.get("egenskaper", [])}
        loc = o.get("lokasjon", {})
        wkt = loc.get("geometri", {}).get("wkt")
        refs = [r.get("kortform", "").split(" ")[0] for r in loc.get("vegsystemreferanser", [])]
        road = next((r for r in refs if r[:2] in ("EV", "RV", "FV")), None)
        status = props.get("Status") or "Operativ"
        if not wkt or not road or not props.get("Målestasjonsnummer") or status.startswith("Nedlagt"):
            continue
        z = shapely.get_coordinates(shapely.from_wkt(wkt), include_z=True)[0][2]
        point = lonlat(wkt)
        stations.append(
            {
                "station_id": str(props["Målestasjonsnummer"]),
                "name": props.get("Navn") or road,
                "road": road,
                "point": point,
                "elevation_m": float(z),
                "climate": climate(float(z), point.y),
                "stale": status != "Operativ",
            }
        )
    unique = {s["station_id"]: s for s in stations}  # NVDB can hold one station twice
    return sorted(unique.values(), key=lambda s: s["station_id"])


def fetch_road(road: str) -> tuple[dict[tuple, list[LineString]], list[tuple[str, LineString]]]:
    url = (
        f"{BASE}/vegnett/api/v4/veglenkesekvenser/segmentert?fylke={COUNTY}&vegsystemreferanse={road}"
        f"&srid=4326&antall=500"
    )
    groups: dict[tuple, list[LineString]] = defaultdict(list)
    segments = []
    for s in pages(url):
        ref = s.get("vegsystemreferanse", {})
        st = ref.get("strekning", {})
        if (
            s.get("type") != "HOVED"
            or "sideanlegg" in ref
            or "kryssystem" in ref
            or st.get("trafikantgruppe") != "K"
        ):
            continue
        line = lonlat(s["geometri"]["wkt"])
        if isinstance(line, LineString) and not line.is_empty:
            groups[(st.get("strekning"), st.get("delstrekning"))].append(line)
            segments.append((s["referanse"], line))
    return groups, segments


def road_lines(groups: dict[tuple, list[LineString]]) -> list[LineString]:
    out = []
    for lines in groups.values():
        merged = linemerge(MultiLineString(lines))
        for piece in merged.geoms if isinstance(merged, MultiLineString) else [merged]:
            out.append(piece.simplify(SIMPLIFY_DEG))
    return out


def main() -> None:
    print("stations")
    stations = fetch_stations()
    print(f"  {len(stations)} operative stations")
    roads, segments = [], []  # roads: (road, line); segments: (road, referanse, line)
    for road in sorted({s["road"] for s in stations}):
        groups, segs = fetch_road(road)
        lines = road_lines(groups)
        roads += [(road, line) for line in lines]
        segments += [(road, ref, line) for ref, line in segs]
        total_km = sum(length_m(x) for x in lines) / 1000
        print(f"{road}: {len(segs)} segments, {total_km:.0f} km, {len(lines)} lines")

    for s in stations:
        own = [seg for seg in segments if seg[0] == s["road"]]
        seg = own[int(STRtree([x[2] for x in own]).nearest(s["point"]))]
        s["road_segment_id"], s["segment"] = seg[1], seg[2]
    stale = next((s["station_id"] for s in stations if s["stale"]), stations[-1]["station_id"])

    def display(road: str) -> tuple[str, str]:
        return {"EV": "E", "RV": "R", "FV": "F"}[road[:2]], road[2:]

    lines = [
        "-- nvdb_seed.sql: generated by tools/mock_dashboards/fetch_nvdb.py. Do not edit by hand.",
        "-- Real Troms roads, stations and their nearest main-road segment (Statens vegvesen, NVDB, NLOD).",
        "",
        "CREATE SCHEMA IF NOT EXISTS frostsight.mock COMMENT 'Mock gold layer for dashboard previews';",
        "",
        "CREATE OR REPLACE TABLE frostsight.mock.seed_roads (",
        "  road_category STRING, road_number STRING, line_no INT, length_m DOUBLE,",
        "  geometry_wkt_4326 STRING);",
    ]
    road_rows, point_rows = [], []
    for i, (road, line) in enumerate(roads):
        cat, num = display(road)
        road_rows.append(
            f"('{cat}', '{num}', {i}, {length_m(line):.0f}, "
            f"{sql_str(shapely.to_wkt(line, rounding_precision=5))})"
        )
        n = max(1, int(length_m(line) // POINT_M))
        for k in range(n + 1):
            p = line.interpolate(k / n, normalized=True)
            point_rows.append(f"('{cat}', '{num}', {i}, {k}, {p.y:.5f}, {p.x:.5f})")
    lines += inserts("seed_roads", road_rows, 20)
    lines += [
        "CREATE OR REPLACE TABLE frostsight.mock.seed_road_points (",
        "  road_category STRING, road_number STRING, line_no INT, seq INT,",
        "  latitude DOUBLE, longitude DOUBLE);",
    ]
    lines += inserts("seed_road_points", point_rows, 500)

    lines += [
        "CREATE OR REPLACE TABLE frostsight.mock.seed_segments (",
        "  road_segment_id STRING, road_category STRING, road_number STRING, length_m DOUBLE,",
        "  centroid_lat DOUBLE, centroid_lon DOUBLE, geometry_wkt_4326 STRING);",
    ]
    seg_rows = []
    for s in stations:
        cat, num = display(s["road"])
        mid = s["segment"].interpolate(0.5, normalized=True)
        seg_rows.append(
            f"({sql_str(s['road_segment_id'])}, '{cat}', '{num}', {length_m(s['segment']):.1f}, "
            f"{mid.y:.6f}, {mid.x:.6f}, {sql_str(shapely.to_wkt(s['segment'], rounding_precision=6))})"
        )
    lines += inserts("seed_segments", sorted(set(seg_rows)), 50)

    lines += [
        "-- silent_min: minutes without readings before now (the stale station)",
        "CREATE OR REPLACE TABLE frostsight.mock.seed_stations (",
        "  station_id STRING, name STRING, road_category STRING, road_number STRING,",
        "  latitude DOUBLE, longitude DOUBLE, climate STRING, silent_min INT, road_segment_id STRING);",
    ]
    station_rows = []
    for s in stations:
        cat, num = display(s["road"])
        station_rows.append(
            f"({sql_str(s['station_id'])}, {sql_str(s['name'])}, '{cat}', '{num}', "
            f"{s['point'].y:.5f}, {s['point'].x:.5f}, '{s['climate']}', "
            f"{90 if s['station_id'] == stale else 0}, {sql_str(s['road_segment_id'])})"
        )
    lines += inserts("seed_stations", station_rows, 50)

    used: set[str] = {stale}
    incident_rows, labels = [], {}
    for n, (kind, severity, start, end, text, wanted) in enumerate(INCIDENTS, 1):
        by_height = sorted(stations, key=lambda s: -s["elevation_m"])
        pick = next(
            (s for s in by_height if s["climate"] == wanted and s["station_id"] not in used),
            next(s for s in by_height if s["station_id"] not in used),
        )
        used.add(pick["station_id"])
        labels.setdefault(kind, pick)
        incident_rows.append(
            f"('MOCK_{9900 + n}', '{kind}', '{severity}', {sql_str(pick['station_id'])}, "
            f"{start}, {end if end is not None else 'NULL'}, {sql_str(text)})"
        )
    lines += [
        "-- ages are minutes before now; end_age_min NULL means still open",
        "CREATE OR REPLACE TABLE frostsight.mock.seed_incidents (",
        "  incident_id STRING, incident_type STRING, severity STRING, station_id STRING,",
        "  start_age_min INT, end_age_min INT, description STRING);",
    ]
    lines += inserts("seed_incidents", incident_rows, 50)
    OUT_SQL.write_text("\n".join(lines) + "\n")

    closure = labels["CLOSURE"]
    cat, num = display(closure["road"])
    prefix = {"E": "E", "R": "Rv", "F": "Fv"}[cat]
    stale_station = next(s for s in stations if s["station_id"] == stale)
    OUT_META.write_text(
        json.dumps(
            {
                "default_segment": f"{prefix}{num} · {closure['name']}",
                "climates": {
                    c: sorted(s["name"] for s in stations if s["climate"] == c)
                    for c in ("mountain", "inland", "fjord", "coast", "warm")
                },
                "closure_station": closure["name"],
                "stale_station": stale_station["name"],
                "stations": len(stations),
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n"
    )
    print(
        f"wrote {OUT_SQL.name} ({OUT_SQL.stat().st_size // 1024} KB: {len(road_rows)} road lines, "
        f"{len(point_rows)} road points, {len(stations)} stations) and {OUT_META.name}"
    )


if __name__ == "__main__":
    main()
