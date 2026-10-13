# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy", "pillow"]
# ///
"""Bake the showcase's static scene assets from reference data.

Per station: the road corridor (6 km each side, every 25 m) and a 14 km terrain heightmap, in a local metre
grid centred on the station (x east, z south). Per region (REGIONS): an overview with the county outlines,
the seed roads and one pin per station.
Run by hand from showcase/: `uv run tools/bake_sites.py --out public`. Outputs are committed.

Sources: NVDB roads and stations from tools/mock_dashboards/nvdb_seed.sql (Statens vegvesen, NLOD),
county outline from Kartverket (ws.geonorge.no), elevation from Mapzen Terrarium tiles on AWS Open Data.
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import math
import re
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

HALF_M = 6000.0
STEP_M = 25.0
TERRAIN_SIZE_M = 14000.0
TERRAIN_N = 128
TILE_ZOOM = 11
OVERVIEW_ZOOM = 8
OVERVIEW_N = 256
KM_MARK_M = 2000.0
M_PER_DEG_LAT = 110574.0
M_PER_DEG_LON_EQ = 111320.0
TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
COUNTY = "https://ws.geonorge.no/kommuneinfo/v1/fylker/{fylke}/omrade?utkoordsys=4326"
# Overview regions: Oslo sits inside Akershus and has three stations, so the two share one overview
REGIONS = [
    {"id": "troms", "name": "Troms", "counties": ["Troms"], "fylker": ["55"]},
    {
        "id": "oslo-akershus",
        "name": "Oslo and Akershus",
        "counties": ["Oslo", "Akershus"],
        "fylker": ["03", "32"],
    },
    {"id": "innlandet", "name": "Innlandet", "counties": ["Innlandet"], "fylker": ["34"]},
]
HERE = Path(__file__).resolve()
SEED = HERE.parents[2] / "tools" / "mock_dashboards" / "nvdb_seed.sql"
CACHE = HERE.parents[1] / ".cache"

XZ = tuple[float, float]


@dataclass
class Road:
    road_category: str
    road_number: str
    line_no: int
    points: list[tuple[float, float]]  # (lon, lat)
    county: str = "Troms"  # seeds written before the county column were Troms only


@dataclass
class Station:
    station_id: str
    name: str
    road_category: str
    road_number: str
    lat: float
    lon: float
    climate: str
    road_segment_id: str
    county: str = "Troms"


def road_label(category: str, number: str) -> str:
    """NVDB category plus number as people write it, the same rule as gold's ROAD_LABEL: E8, Rv83, Fv91."""
    return {"E": "E", "R": "Rv", "F": "Fv", "K": "Kv"}.get(category, "") + number


def parse_wkt_linestring(wkt: str) -> list[tuple[float, float]]:
    body = wkt[wkt.index("(") + 1 : wkt.rindex(")")]
    return [(float(a), float(b)) for a, b in (p.split() for p in body.split(","))]


_ROAD_ROW = re.compile(
    r"\('([^']*)',\s*'([^']*)',\s*(-?\d+),\s*[-\d.]+,\s*'(LINESTRING[^']*)'(?:,\s*'([^']*)')?\)"
)
_STATION_ROW = re.compile(
    r"\('([^']*)',\s*'((?:[^']|'')*)',\s*'([^']*)',\s*'([^']*)',\s*(-?[\d.]+),\s*(-?[\d.]+),\s*'([^']*)',"
    r"\s*-?\d+,\s*'([^']*)'(?:,\s*'([^']*)')?\)"
)


def _blocks(sql_text: str, table: str) -> str:
    marker = f"INSERT INTO frostsight.mock.{table} VALUES"
    out, start = [], sql_text.find(marker)
    while start != -1:
        end = sql_text.find(";", start)
        out.append(sql_text[start : end if end != -1 else len(sql_text)])
        start = sql_text.find(marker, start + len(marker))
    return "\n".join(out)


def load_seed(sql_text: str) -> tuple[list[Road], list[Station]]:
    roads = [
        Road(c, n, int(line), parse_wkt_linestring(wkt), county or "Troms")
        for c, n, line, wkt, county in _ROAD_ROW.findall(_blocks(sql_text, "seed_roads"))
    ]
    rows = _STATION_ROW.findall(_blocks(sql_text, "seed_stations"))
    stations = [
        Station(sid, name.replace("''", "'"), c, n, float(lat), float(lon), climate, seg, county or "Troms")
        for sid, name, c, n, lat, lon, climate, seg, county in rows
    ]
    return roads, stations


def region_of(county: str) -> str:
    return next(r["id"] for r in REGIONS if county in r["counties"])


def project_local(lon: float, lat: float, lon0: float, lat0: float) -> XZ:
    """Metres east (x) and south (z) of the origin; north is negative z, as in the scene."""
    x = (lon - lon0) * math.cos(math.radians(lat0)) * M_PER_DEG_LON_EQ
    z = -(lat - lat0) * M_PER_DEG_LAT
    return x, z


def unproject_local(x: float, z: float, lon0: float, lat0: float) -> tuple[float, float]:
    return lon0 + x / (math.cos(math.radians(lat0)) * M_PER_DEG_LON_EQ), lat0 - z / M_PER_DEG_LAT


def cumulative_m(points: list[XZ]) -> list[float]:
    out = [0.0]
    for (x0, z0), (x1, z1) in zip(points, points[1:], strict=False):
        out.append(out[-1] + math.hypot(x1 - x0, z1 - z0))
    return out


def nearest_index(points: list[XZ], target: XZ) -> int:
    tx, tz = target
    return min(range(len(points)), key=lambda i: (points[i][0] - tx) ** 2 + (points[i][1] - tz) ** 2)


def _point_at(points: list[XZ], cum: list[float], s: float) -> XZ:
    i = max(0, min(len(cum) - 2, int(np.searchsorted(cum, s, side="right")) - 1))
    span = cum[i + 1] - cum[i]
    t = 0.0 if span == 0 else (s - cum[i]) / span
    (x0, z0), (x1, z1) = points[i], points[i + 1]
    return x0 + (x1 - x0) * t, z0 + (z1 - z0) * t


def cut_corridor(
    points: list[XZ], station_idx: int, half_m: float = HALF_M, step_m: float = STEP_M
) -> tuple[list[XZ], float]:
    """Cut the road to half_m each side of the station's nearest point (clamped at the road ends) and resample
    every step_m. Returns the points and the station's distance from the corridor start."""
    cum = cumulative_m(points)
    s0 = cum[station_idx]
    start, end = max(0.0, s0 - half_m), min(cum[-1], s0 + half_m)
    marks = list(np.arange(start, end, step_m))
    if not marks or end - marks[-1] > 1e-6:
        marks.append(end)
    return [_point_at(points, cum, float(s)) for s in marks], s0 - start


def pick_road(roads: list[Road], station: Station) -> Road:
    key = (station.road_category, station.road_number)
    same = [r for r in roads if (r.road_category, r.road_number) == key]

    def dist(r: Road) -> float:
        return min(math.hypot(*project_local(lon, lat, station.lon, station.lat)) for lon, lat in r.points)

    return min(same or roads, key=dist)


LonLat = tuple[float, float]


def chain_lines(
    lines: list[list[LonLat]], start: int, tol_m: float = 50.0, max_links: int = 8
) -> list[LonLat]:
    """Extend lines[start] at both ends with the pieces that touch it (within tol_m), so a corridor can run
    past the end of one NVDB seed piece. Pieces may be stored in either direction."""

    def gap(p: tuple[float, float], q: tuple[float, float]) -> float:
        return math.hypot(*project_local(p[0], p[1], q[0], q[1]))

    chain = list(lines[start])
    used = {start}
    for _ in range(max_links):
        grown = False
        for i, line in enumerate(lines):
            if i in used or len(line) < 2:
                continue
            if gap(chain[-1], line[0]) <= tol_m:
                chain += line[1:]
            elif gap(chain[-1], line[-1]) <= tol_m:
                chain += line[-2::-1]
            elif gap(chain[0], line[-1]) <= tol_m:
                chain = line[:-1] + chain
            elif gap(chain[0], line[0]) <= tol_m:
                chain = line[:0:-1] + chain
            else:
                continue
            used.add(i)
            grown = True
        if not grown:
            break
    return chain


def decode_terrarium(rgb: np.ndarray) -> np.ndarray:
    rgb = rgb.astype(np.float64)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def tile_xy(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    fx, fy = _tile_frac(lon, lat, z)
    return min(n - 1, int(fx)), min(n - 1, int(fy))


def _tile_frac(lon: float, lat: float, z: int) -> tuple[float, float]:
    n = 2**z
    r = math.radians(lat)
    return (lon + 180.0) / 360.0 * n, (1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * n


def resample_box(
    elev_fn: Callable[[float, float], float],
    origin: tuple[float, float],
    size_m: float = TERRAIN_SIZE_M,
    n: int = TERRAIN_N,
) -> np.ndarray:
    """n x n heights over a size_m square centred on origin (lon, lat); row 0 is the north edge."""
    lon0, lat0 = origin
    coords = np.linspace(-size_m / 2, size_m / 2, n)
    out = np.zeros((n, n))
    for i, z in enumerate(coords):
        for j, x in enumerate(coords):
            out[i, j] = elev_fn(*unproject_local(float(x), float(z), lon0, lat0))
    return out


def encode_heights(hm: np.ndarray) -> tuple[bytes, float, float]:
    lo, hi = float(hm.min()), float(hm.max())
    scaled = np.zeros_like(hm) if hi == lo else (hm - lo) / (hi - lo) * 65535.0
    return np.round(scaled).astype("<u2").tobytes(), lo, hi


def simplify(points: list[XZ], tol_m: float) -> list[XZ]:
    """Douglas-Peucker."""
    if len(points) < 3:
        return list(points)
    (x0, z0), (x1, z1) = points[0], points[-1]
    dx, dz = x1 - x0, z1 - z0
    norm = math.hypot(dx, dz)
    best, idx = -1.0, 0
    for i in range(1, len(points) - 1):
        px, pz = points[i]
        d = math.hypot(px - x0, pz - z0) if norm == 0 else abs(dz * (px - x0) - dx * (pz - z0)) / norm
        if d > best:
            best, idx = d, i
    if best <= tol_m:
        return [points[0], points[-1]]
    return simplify(points[: idx + 1], tol_m)[:-1] + simplify(points[idx:], tol_m)


# ---------- I/O ----------


def _get(url: str, cache_name: str) -> bytes:
    path = CACHE / cache_name
    if path.exists():
        return path.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "FrostSight showcase bake (NLOD research demo)"})
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            break
        except (OSError, http.client.HTTPException):
            if attempt == 7:
                raise
            time.sleep(1 + attempt * 2)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def _terrarium_sampler(zoom: int = TILE_ZOOM) -> Callable[[float, float], float]:
    from PIL import Image

    tiles: dict[tuple[int, int], np.ndarray] = {}

    def elev(lon: float, lat: float) -> float:
        fx, fy = _tile_frac(lon, lat, zoom)
        key = (int(fx), int(fy))
        if key not in tiles:
            x, y = key
            raw = _get(TERRARIUM.format(z=zoom, x=x, y=y), f"tiles/{zoom}/{x}/{y}.png")
            tiles[key] = decode_terrarium(np.asarray(Image.open(io.BytesIO(raw)).convert("RGB")))
        px = min(255, int((fx - key[0]) * 256))
        py = min(255, int((fy - key[1]) * 256))
        return max(0.0, float(tiles[key][py, px]))  # sea level floor: fjords read as water at 0 m

    return elev


def bake_site(station: Station, roads: list[Road], out: Path, terrain: bool) -> dict:
    road = pick_road(roads, station)
    same = [r for r in roads if (r.road_category, r.road_number) == (road.road_category, road.road_number)]
    chained = chain_lines([r.points for r in same], same.index(road))
    local = [project_local(lon, lat, station.lon, station.lat) for lon, lat in chained]
    dense = [p for p in _densify(local, 25.0)]
    pts, at = cut_corridor(dense, nearest_index(dense, (0.0, 0.0)))
    length = cumulative_m(pts)[-1]
    doc = {
        "station_id": station.station_id,
        "name": station.name,
        "road": road_label(station.road_category, station.road_number),
        "climate": station.climate,
        "county": station.county,
        "region": region_of(station.county),
        "road_segment_id": station.road_segment_id,
        "origin": {"lat": station.lat, "lon": station.lon},
        "points": [[round(x, 1), round(z, 1)] for x, z in pts],
        "station_at_m": round(at, 1),
        "length_m": round(length, 1),
        "km_marks": [
            {"at_m": float(m), "label": f"km {int(m // 1000)}"}
            for m in np.arange(0.0, length + 1e-6, KM_MARK_M)
        ],
        "terrain": {"n": TERRAIN_N, "size_m": TERRAIN_SIZE_M, "min_m": 0.0, "max_m": 0.0},
    }
    folder = out / "sites" / station.station_id
    folder.mkdir(parents=True, exist_ok=True)
    if terrain:
        data, lo, hi = encode_heights(resample_box(_terrarium_sampler(), (station.lon, station.lat)))
        (folder / "terrain.bin").write_bytes(data)
        doc["terrain"].update(min_m=round(lo, 1), max_m=round(hi, 1))
    elif (folder / "road.json").exists():
        doc["terrain"] = json.loads((folder / "road.json").read_text())["terrain"]
    (folder / "road.json").write_text(json.dumps(doc, ensure_ascii=False) + "\n")
    return doc


def _densify(points: list[XZ], step: float) -> list[XZ]:
    cum = cumulative_m(points)
    return [_point_at(points, cum, float(s)) for s in np.arange(0.0, cum[-1], step)] + [points[-1]]


def bake_overview(region: dict, roads: list[Road], stations: list[Station], out: Path) -> None:
    polys = []
    for fylke in region["fylker"]:
        geo = json.loads(_get(COUNTY.format(fylke=fylke), f"county{fylke}.json"))["omrade"]
        polys += geo["coordinates"] if geo["type"] == "MultiPolygon" else [geo["coordinates"]]
    roads = [r for r in roads if r.county in region["counties"]]
    stations = [s for s in stations if s.county in region["counties"]]
    lons = [lon for poly in polys for lon, _ in poly[0]]
    lats = [lat for poly in polys for _, lat in poly[0]]
    lon0, lat0 = (min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2

    def proj(ring: list[list[float]], tol: float) -> list[list[float]]:
        local = [project_local(lo, la, lon0, lat0) for lo, la in ring]
        return [[round(x), round(z)] for x, z in simplify(local, tol)]

    # The county polygon includes its sea territory, so land and fjords come from a coarse elevation grid
    # (sea floored at 0 m) and the outline is drawn as a border line.
    xs = [project_local(lo, la, lon0, lat0)[0] for poly in polys for lo, la in poly[0]]
    zs = [project_local(lo, la, lon0, lat0)[1] for poly in polys for lo, la in poly[0]]
    size = math.ceil(max(max(xs) - min(xs), max(zs) - min(zs)) / 1000.0 + 10) * 1000.0
    hm = resample_box(_terrarium_sampler(OVERVIEW_ZOOM), (lon0, lat0), size_m=size, n=OVERVIEW_N)
    data, lo, hi = encode_heights(hm)
    folder = out / "overview" / region["id"]
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "terrain.bin").write_bytes(data)
    terrain = {"n": OVERVIEW_N, "size_m": size, "min_m": round(lo, 1), "max_m": round(hi, 1)}
    county = {
        "origin": {"lat": lat0, "lon": lon0},
        "rings": [proj(p[0], 300.0) for p in polys],
        "terrain": terrain,
    }
    (folder / "county.json").write_text(json.dumps(county) + "\n")
    lines = [
        {
            "road": road_label(r.road_category, r.road_number),
            "points": proj([list(p) for p in r.points], 100.0),
        }
        for r in roads
    ]
    (folder / "roads.json").write_text(json.dumps(lines) + "\n")
    pins = [
        {
            "station_id": s.station_id,
            "name": s.name,
            "climate": s.climate,
            "road": road_label(s.road_category, s.road_number),
            "xz": [round(v) for v in project_local(s.lon, s.lat, lon0, lat0)],
        }
        for s in stations
    ]
    (folder / "stations.json").write_text(json.dumps(pins, ensure_ascii=False) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seed", type=Path, default=SEED)
    ap.add_argument("--station", action="append", default=[])
    ap.add_argument("--skip-terrain", action="store_true")
    ap.add_argument("--skip-overview", action="store_true")
    a = ap.parse_args()
    roads, stations = load_seed(a.seed.read_text())
    chosen = [s for s in stations if not a.station or s.station_id in a.station]
    for s in chosen:
        doc = bake_site(s, roads, a.out, not a.skip_terrain)
        t = doc["terrain"]
        print(
            f"{s.station_id} {s.name:24} {doc['road']:6} {doc['length_m']:8.0f} m  "
            f"station at {doc['station_at_m']:6.0f} m  terrain {t['min_m']:.0f}-{t['max_m']:.0f} m"
        )
    if not a.skip_overview:
        index = []
        for region in REGIONS:
            bake_overview(region, roads, stations, a.out)
            ids = sorted(s.station_id for s in stations if s.county in region["counties"])
            keep = {k: region[k] for k in ("id", "name", "counties")}
            index.append({**keep, "stations": ids})
            print(f"overview {region['id']} written ({len(ids)} stations)")
        (a.out / "overview" / "index.json").write_text(json.dumps(index, ensure_ascii=False) + "\n")
    sites = sorted(p.name for p in (a.out / "sites").iterdir() if p.is_dir())
    (a.out / "sites" / "index.json").write_text(json.dumps(sites) + "\n")


if __name__ == "__main__":
    main()
