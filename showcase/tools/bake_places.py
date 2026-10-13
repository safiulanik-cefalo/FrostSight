# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy", "pillow", "pyproj"]
# ///
"""Bake land cover and place names per site for the /v2/ page, beside the v1 assets (which it never writes).

Per station, over the same box as terrain.bin:
  public/sites/<id>/cover.bin    COVER_N x COVER_N uint8 land-cover classes, row 0 north (codes in CLASSES)
  public/sites/<id>/places.json  thinned, ranked place-name labels in local metres (x east, z south)

Sources: NIBIO AR5 land type and tree species (WMS, CC BY 4.0), Kartverket place names (SSR, CC BY 4.0).
Run by hand from showcase/ after tools/bake_sites.py: `uv run tools/bake_places.py --out public`.
Outputs are committed. Downloads are cached in showcase/.cache, so a re-run only re-derives.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bake_sites import CACHE, SEED, load_seed, project_local, unproject_local  # noqa: E402

COVER_N = 256
WMS_PX = 2048
SUBSAMPLE = 5  # per cover cell, a SUBSAMPLE x SUBSAMPLE majority vote over the WMS pixels
WMS = "https://wms.nibio.no/cgi-bin/ar5"
SSR = "https://api.kartverket.no/stedsnavn/v1/punkt"
SSR_RADIUS_M = 5000.0  # the API's maximum
UA = "FrostSight showcase bake (NLOD research demo)"
ATTRIBUTION = ["Land cover NIBIO AR5 (CC BY 4.0)", "Place names Kartverket (CC BY 4.0)"]

# cover.bin class codes; the app's src/v2/cover.ts mirrors them
(
    UNMAPPED,
    BUILT,
    ROAD,
    FARM,
    FOREST_LEAF,
    FOREST_CONIFER,
    FOREST_MIXED,
    BOG,
    OPEN,
    FRESHWATER,
    SEA,
    GLACIER,
) = range(12)
CLASSES = {
    "unmapped": UNMAPPED, "built": BUILT, "road": ROAD, "farm": FARM, "forest_leaf": FOREST_LEAF,
    "forest_conifer": FOREST_CONIFER, "forest_mixed": FOREST_MIXED, "bog": BOG, "open": OPEN,
    "freshwater": FRESHWATER, "sea": SEA, "glacier": GLACIER,
}  # fmt: skip
# AR5 legend colours (sampled from GetLegendGraphic) -> class. White is outside AR5's mapped area.
AREALTYPE = [
    ((255, 255, 255), UNMAPPED),
    ((255, 209, 110), FARM),  # fulldyrka jord
    ((255, 255, 76), FARM),  # overflatedyrka jord
    ((255, 255, 173), FARM),  # innmarksbeite
    ((158, 204, 115), FOREST_MIXED),  # skog; the species comes from the Treslag layer
    ((181, 236, 252), BOG),  # myr, drawn as stripes on white
    ((217, 217, 217), OPEN),  # åpen fastmark
    ((145, 231, 255), FRESHWATER),
    ((204, 254, 254), SEA),
    ((230, 255, 255), GLACIER),
    ((252, 219, 214), BUILT),  # bebygd
    ((179, 120, 76), ROAD),  # samferdsel
]
TRESLAG = [
    ((255, 255, 255), UNMAPPED),
    ((125, 191, 110), FOREST_CONIFER),  # barskog
    ((128, 255, 8), FOREST_LEAF),  # lauvskog
    ((158, 204, 115), FOREST_MIXED),  # blandingsskog
    ((207, 204, 145), OPEN),  # ikke tresatt
]
FORESTS = (FOREST_LEAF, FOREST_CONIFER, FOREST_MIXED)
VOTE_WEIGHT = {BOG: 3}  # bog stripes cover about a third of their area; white between them must not win

# SSR navneobjekttype -> (kind, tier, min spacing m between labels of the kind, cap per site).
# Tier 1 shows from afar, tier 2 nearer, tier 3 only close up; the page also hides labels that collide.
NAME_TYPES: dict[str, tuple[str, int, float, int]] = {
    "By": ("town", 1, 1500, 3),
    "Tettsted": ("town", 1, 1500, 3),
    "Bydel": ("district", 1, 900, 10),
    "Tettbebyggelse": ("village", 2, 900, 6),
    "Grend": ("village", 2, 900, 6),
    "Bygdelag (bygd)": ("village", 2, 900, 6),
    "Bru": ("bridge", 1, 500, 4),
    "Tunnel": ("tunnel", 1, 500, 4),
    "Øy i sjø": ("island", 1, 1500, 5),
    "Fjord": ("fjord", 1, 2500, 3),
    "Sund i sjø": ("sound", 2, 2000, 3),
    "Fjell": ("peak", 2, 1200, 8),
    "Topp": ("peak", 2, 1200, 8),
    "Dal": ("valley", 2, 1500, 5),
    "Vann": ("lake", 2, 800, 5),
    "Innsjø": ("lake", 2, 800, 5),
    "Elv": ("river", 3, 1500, 3),
    "Nes i sjø": ("cape", 3, 1500, 4),
    "Universitet/høgskole": ("landmark", 2, 600, 2),
    "Sykehus": ("landmark", 2, 600, 2),
    "Kirke": ("landmark", 3, 600, 3),
}
# Within a tier, the kinds people recognise first are placed first
KIND_ORDER = [
    "town", "fjord", "island", "bridge", "tunnel", "district", "village",
    "peak", "valley", "sound", "lake", "landmark", "river", "cape",
]  # fmt: skip
MAX_LABELS = 45
# Labels of different kinds are only thinned when they share a point: SSR puts "Tromsø" 60 m from
# Tromsøbrua, and the page lifts each kind to its own height and hides on-screen collisions.
CROSS_KIND_MIN_M = 40.0
NUMBERED = re.compile(r"\s\d+$")  # "Tromsøysund 2" is a second tunnel tube, not a place
# Register names of ramps ("Bispelokket, Rampe opp fra ...", "Furuset påkjøringsrampe") are descriptions,
# not names people use
MAX_NAME_CHARS = 28
RAMP = re.compile(r"rampe", re.IGNORECASE)


# ---------- land cover ----------


def classify(rgb: np.ndarray, table: list[tuple[tuple[int, int, int], int]]) -> np.ndarray:
    """Nearest legend colour per pixel -> class code. Anti-aliased edges fall to the closest swatch."""
    cols = np.array([c for c, _ in table], dtype=np.int32)
    codes = np.array([k for _, k in table], dtype=np.uint8)
    flat = rgb.reshape(-1, 3).astype(np.int32)
    best = np.zeros(len(flat), dtype=np.int64)
    best_d = np.full(len(flat), np.iinfo(np.int32).max, dtype=np.int64)
    for k, c in enumerate(cols):
        d = ((flat - c) ** 2).sum(1)
        closer = d < best_d
        best[closer], best_d[closer] = k, d[closer]
    return codes[best].reshape(rgb.shape[:2])


def merge_species(areal: np.ndarray, tres: np.ndarray) -> np.ndarray:
    """AR5's forest class split by the tree-species layer; any other species value stays mixed forest."""
    out = areal.copy()
    forest = areal == FOREST_MIXED
    out[forest] = np.where(np.isin(tres[forest], FORESTS), tres[forest], FOREST_MIXED)
    return out


def majority(samples: np.ndarray, n_classes: int = len(CLASSES)) -> np.ndarray:
    """Per row of class samples, the class with the most (weighted) votes; ties go to the lower code."""
    w = np.ones(n_classes)
    for k, v in VOTE_WEIGHT.items():
        w[k] = v
    counts = np.zeros((samples.shape[0], n_classes))
    for k in range(n_classes):
        counts[:, k] = (samples == k).sum(1) * w[k]
    return counts.argmax(1).astype(np.uint8)


def cover_grid(
    classes: np.ndarray,
    bbox: tuple[float, float, float, float],
    lon0: float,
    lat0: float,
    size_m: float,
    to_utm,
    n: int = COVER_N,
) -> np.ndarray:
    """Resample a classified UTM image (bbox x0, y0, x1, y1) to the site's n x n local grid, row 0 north."""
    coords = np.linspace(-size_m / 2, size_m / 2, n)
    cell = size_m / (n - 1)
    offs = np.linspace(-cell * 0.4, cell * 0.4, SUBSAMPLE)
    zz, xx, dz, dx = np.meshgrid(coords, coords, offs, offs, indexing="ij")
    lon, lat = unproject_local_arr(xx + dx, zz + dz, lon0, lat0)
    ux, uy = to_utm.transform(lon, lat)
    h, w = classes.shape
    px = np.clip(((ux - bbox[0]) / (bbox[2] - bbox[0]) * w).astype(int), 0, w - 1)
    py = np.clip(((bbox[3] - uy) / (bbox[3] - bbox[1]) * h).astype(int), 0, h - 1)
    samples = classes[py, px].reshape(n * n, SUBSAMPLE * SUBSAMPLE)
    return majority(samples).reshape(n, n)


def unproject_local_arr(
    x: np.ndarray, z: np.ndarray, lon0: float, lat0: float
) -> tuple[np.ndarray, np.ndarray]:
    """Vectorised unproject_local from bake_sites (same constants, checked by a unit test)."""
    lon, lat = unproject_local(1.0, 1.0, lon0, lat0)
    per_x, per_z = lon - lon0, lat0 - lat  # degrees per metre east, and per metre south (negated)
    return lon0 + x * per_x, lat0 - z * per_z


def bake_cover(lon0: float, lat0: float, size_m: float) -> np.ndarray:
    from pyproj import Transformer

    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)
    ex, ey = to_utm.transform(lon0, lat0)
    # UTM 33 is rotated against the local grid away from 15°E; the margin keeps the corners inside the image
    half = size_m / 2 * 1.12
    bbox = (ex - half, ey - half, ex + half, ey + half)
    tag = f"ar5/{lat0:.5f}_{lon0:.5f}_{half:.0f}m_{WMS_PX}px"
    areal = classify(wms_rgb("Arealtype", bbox, f"{tag}_arealtype.png"), AREALTYPE)
    tres = classify(wms_rgb("Treslag", bbox, f"{tag}_treslag.png"), TRESLAG)
    return cover_grid(merge_species(areal, tres), bbox, lon0, lat0, size_m, to_utm)


def wms_rgb(layer: str, bbox: tuple[float, float, float, float], cache: str) -> np.ndarray:
    x0, y0, x1, y1 = bbox
    url = (
        f"{WMS}?service=WMS&version=1.3.0&request=GetMap&layers={layer}&styles=&crs=EPSG:25833"
        f"&bbox={x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}&width={WMS_PX}&height={WMS_PX}&format=image/png"
    )
    raw = fetch(url, cache, check=lambda b: Image.open(io.BytesIO(b)).verify())
    return np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"))


# ---------- place names ----------


def fetch_names(lon0: float, lat0: float, half_m: float) -> list[dict]:
    """All SSR names in the box: a 3 x 3 grid of SSR_RADIUS_M circles, deduplicated by stedsnummer."""
    step = half_m * 2 / 3
    names: dict[int, dict] = {}
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            lon, lat = unproject_local(dj * step, di * step, lon0, lat0)
            for page in range(1, 200):
                url = (
                    f"{SSR}?nord={lat:.5f}&ost={lon:.5f}&koordsys=4258&radius={SSR_RADIUS_M:.0f}"
                    f"&utkoordsys=4258&treffPerSide=200&side={page}"
                )
                d = json.loads(fetch(url, f"ssr/{lat:.5f}_{lon:.5f}_{page}.json", check=_ssr_page))
                for x in d["navn"]:
                    names[x["stedsnummer"]] = x
                if d["metadata"]["viserTil"] >= d["metadata"]["totaltAntallTreff"]:
                    break
    return list(names.values())


def _ssr_page(raw: bytes) -> None:
    d = json.loads(raw)
    if "navn" not in d or "metadata" not in d:
        raise ValueError("not an SSR result page")


def main_name(entry: dict) -> str | None:
    """The approved main name, Norwegian first (Sami and Kven names are main names too). Some places have only
    side names (the village of Lom is "Lom" and "Fossbergom"); then the first side name. Never historic names.
    """
    names = entry.get("stedsnavn", [])
    for status in ("hovednavn", "sidenavn"):
        cands = [s for s in names if s.get("navnestatus") == status]
        cands.sort(key=lambda s: (s.get("språk") != "Norsk", s.get("stedsnavnnummer", 9)))
        if cands:
            return cands[0]["skrivemåte"]
    return None


def pick_labels(names: list[dict], lon0: float, lat0: float, half_m: float) -> list[dict]:
    """Rank and thin SSR names to at most MAX_LABELS. The output order is the page's placement priority."""
    cands = []
    for e in names:
        spec = NAME_TYPES.get(e.get("navneobjekttype", ""))
        if not spec or e.get("stedstatus") != "aktiv":
            continue
        name = main_name(e)
        if (
            not name
            or NUMBERED.search(name)
            or RAMP.search(name)
            or "," in name
            or len(name) > MAX_NAME_CHARS
        ):
            continue
        p = e["representasjonspunkt"]
        x, z = project_local(p["øst"], p["nord"], lon0, lat0)
        if abs(x) > half_m * 0.97 or abs(z) > half_m * 0.97:
            continue
        kind, tier, spacing, cap = spec
        cands.append(
            {
                "name": name,
                "kind": kind,
                "tier": tier,
                "xz": [round(x), round(z)],
                "_sp": spacing,
                "_cap": cap,
            }
        )
    # tier, then kind, then centre-out so the station's surroundings keep their names when a cap bites
    cands.sort(key=lambda c: (c["tier"], KIND_ORDER.index(c["kind"]), math.hypot(*c["xz"]), c["name"]))
    chosen: list[dict] = []
    per_kind: dict[str, int] = {}
    seen: set[str] = set()
    for c in cands:
        if len(chosen) >= MAX_LABELS or per_kind.get(c["kind"], 0) >= c["_cap"] or c["name"] in seen:
            continue
        if any(
            math.dist(c["xz"], o["xz"]) < (c["_sp"] * 0.6 if o["kind"] == c["kind"] else CROSS_KIND_MIN_M)
            for o in chosen
        ):
            continue
        chosen.append(c)
        per_kind[c["kind"]] = per_kind.get(c["kind"], 0) + 1
        seen.add(c["name"])
    return [{k: v for k, v in c.items() if not k.startswith("_")} for c in chosen]


# ---------- I/O ----------


def fetch(url: str, cache_name: str, check) -> bytes:
    """GET through the cache. HTTP errors and bodies that fail `check` are never cached."""
    path = CACHE / cache_name
    if path.exists():
        return path.read_bytes()
    last: Exception | None = None
    for _ in range(4):
        # curl, not urllib: Kartverket's larger pages came back truncated (IncompleteRead) through urllib
        r = subprocess.run(
            ["curl", "-sSf", "-m", "240", "--retry", "3", "--retry-all-errors", "-A", UA, url],
            capture_output=True,
        )
        try:
            if r.returncode != 0:
                raise OSError(r.stderr.decode(errors="replace").strip())
            check(r.stdout)
        except Exception as e:  # noqa: BLE001 - retry any transport or content failure
            last = e
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.stdout)
        return r.stdout
    raise RuntimeError(f"{url}: {last}")


def bake_station(station, out: Path) -> dict:
    folder = out / "sites" / station.station_id
    size_m = json.loads((folder / "road.json").read_text())["terrain"]["size_m"]
    cover = bake_cover(station.lon, station.lat, size_m)
    labels = pick_labels(
        fetch_names(station.lon, station.lat, size_m / 2), station.lon, station.lat, size_m / 2
    )
    (folder / "cover.bin").write_bytes(cover.tobytes())
    doc = {"n": COVER_N, "classes": CLASSES, "places": labels, "attribution": ATTRIBUTION}
    (folder / "places.json").write_text(json.dumps(doc, ensure_ascii=False) + "\n")
    return {
        "labels": len(labels),
        "built": int((cover == BUILT).sum()),
        "unmapped": int((cover == UNMAPPED).sum()),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seed", type=Path, default=SEED)
    ap.add_argument("--station", action="append", default=[])
    a = ap.parse_args()
    _, stations = load_seed(a.seed.read_text())
    chosen = [s for s in stations if not a.station or s.station_id in a.station]
    failed = []
    for k, s in enumerate(chosen, 1):
        try:
            r = bake_station(s, a.out)
        except Exception as e:  # noqa: BLE001 - one bad site must not stop the other hundred
            failed.append(s.station_id)
            print(f"[{k}/{len(chosen)}] {s.station_id} {s.name}: FAILED {e}", flush=True)
            continue
        unmapped = r["unmapped"] / COVER_N**2
        print(
            f"[{k}/{len(chosen)}] {s.station_id} {s.name:24} {r['labels']:2} labels  "
            f"{r['built']:5} built cells  {unmapped:4.0%} unmapped",
            flush=True,
        )
    if failed:
        sys.exit(f"failed: {' '.join(failed)}")


if __name__ == "__main__":
    main()
