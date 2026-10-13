# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy", "pillow", "pyproj"]
# ///
"""SPIKE (throwaway): bake land cover and place names per site for the /v2 page.

Writes beside the v1 assets, which it never touches:
  public/sites/<id>/cover.bin    COVER_N x COVER_N uint8 land-cover classes over the site's terrain box,
                                 row 0 north, same box as terrain.bin (see CLASSES)
  public/sites/<id>/places.json  thinned, tiered place-name labels in local metres (x east, z south)

Sources: NIBIO AR5 WMS (land type and tree species, CC BY 4.0), Kartverket SSR place names (CC BY 4.0).
Run from showcase/: `uv run tools/bake_places.py --out public --station 3000078`.
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
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bake_sites import CACHE, SEED, TERRAIN_SIZE_M, load_seed, project_local, unproject_local  # noqa: E402

COVER_N = 256
WMS_PX = 2048
WMS = "https://wms.nibio.no/cgi-bin/ar5"
SSR = "https://api.kartverket.no/stedsnavn/v1/punkt"
SSR_RADIUS_M = 5000.0
UA = "FrostSight showcase bake (research demo)"

# cover.bin class codes
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
# AR5 "Arealtype" legend colours (sampled from GetLegendGraphic) -> class
AREALTYPE = [
    ((255, 255, 255), UNMAPPED),
    ((255, 209, 110), FARM),  # fulldyrka jord
    ((255, 255, 76), FARM),  # overflatedyrka jord
    ((255, 255, 173), FARM),  # innmarksbeite
    ((158, 204, 115), FOREST_MIXED),  # skog; species refined from the Treslag layer
    ((181, 236, 252), BOG),  # myr stripes on white
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
# Majority vote weight: bog is drawn as sparse stripes on white
WEIGHT = {BOG: 3}

# SSR navneobjekttype -> (kind, tier, min spacing m, cap). Tier 1 is always shown, 3 only close up.
NAME_TYPES: dict[str, tuple[str, int, float, int]] = {
    "By": ("town", 1, 1500, 3),
    "Tettsted": ("town", 1, 1500, 3),
    "Tettbebyggelse": ("village", 2, 900, 6),
    "Bydel": ("district", 1, 900, 10),
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
MAX_LABELS = 45
CROSS_KIND_MIN_M = 40.0
# Within a tier, the kinds people recognise first win the spacing contest
KIND_ORDER = [
    "town",
    "fjord",
    "island",
    "bridge",
    "tunnel",
    "district",
    "village",
    "peak",
    "valley",
    "sound",
    "lake",
    "landmark",
    "river",
    "cape",
]


def fetch(url: str, cache_name: str) -> bytes:
    """curl with retries; urllib truncated Kartverket's larger pages (IncompleteRead) during the spike."""
    path = CACHE / cache_name
    if path.exists():
        return path.read_bytes()
    r = subprocess.run(
        ["curl", "-sS", "-m", "240", "--retry", "4", "-A", UA, url], capture_output=True, check=True
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(r.stdout)
    return r.stdout


def classify(rgb: np.ndarray, table: list[tuple[tuple[int, int, int], int]]) -> np.ndarray:
    """Nearest legend colour per pixel -> class code."""
    cols = np.array([c for c, _ in table], dtype=np.float64)
    codes = np.array([k for _, k in table], dtype=np.uint8)
    flat = rgb.reshape(-1, 3).astype(np.float64)
    d = ((flat[:, None, :] - cols[None, :, :]) ** 2).sum(-1)
    return codes[d.argmin(1)].reshape(rgb.shape[:2])


def wms_classes(layer: str, table: list, bbox: tuple[float, float, float, float], cache: str) -> np.ndarray:
    x0, y0, x1, y1 = bbox
    url = (
        f"{WMS}?service=WMS&version=1.3.0&request=GetMap&layers={layer}&styles=&crs=EPSG:25833"
        f"&bbox={x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}&width={WMS_PX}&height={WMS_PX}&format=image/png"
    )
    img = Image.open(io.BytesIO(fetch(url, cache))).convert("RGB")
    return classify(np.asarray(img), table)


def bake_cover(lon0: float, lat0: float, size_m: float = TERRAIN_SIZE_M, n: int = COVER_N) -> np.ndarray:
    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)
    ex, ey = to_utm.transform(lon0, lat0)
    pad = size_m * 0.08
    half = size_m / 2 + pad
    bbox = (ex - half, ey - half, ex + half, ey + half)
    tag = f"ar5/{lat0:.5f}_{lon0:.5f}"
    areal = wms_classes("Arealtype", AREALTYPE, bbox, f"{tag}_arealtype.png")
    tres = wms_classes("Treslag", TRESLAG, bbox, f"{tag}_treslag.png")
    # cell centres in local metres -> lon/lat -> UTM -> pixel; vote over a 5x5 sub-sample per cell
    coords = np.linspace(-size_m / 2, size_m / 2, n)
    cell = size_m / (n - 1)
    offs = np.linspace(-cell * 0.4, cell * 0.4, 5)
    out = np.zeros((n, n), dtype=np.uint8)
    px_per_m = WMS_PX / (2 * half)
    for i, z in enumerate(coords):
        for j, x in enumerate(coords):
            votes: dict[int, int] = {}
            for dz in offs:
                for dx in offs:
                    lon, lat = unproject_local(float(x + dx), float(z + dz), lon0, lat0)
                    ux, uy = to_utm.transform(lon, lat)
                    px = int((ux - bbox[0]) * px_per_m)
                    py = int((bbox[3] - uy) * px_per_m)
                    if not (0 <= px < WMS_PX and 0 <= py < WMS_PX):
                        continue
                    k = int(areal[py, px])
                    if k == FOREST_MIXED:
                        t = int(tres[py, px])
                        k = t if t in (FOREST_LEAF, FOREST_CONIFER, FOREST_MIXED) else FOREST_MIXED
                    votes[k] = votes.get(k, 0) + WEIGHT.get(k, 1)
            out[i, j] = max(votes, key=votes.__getitem__) if votes else UNMAPPED
    return out


def fetch_names(lon0: float, lat0: float, half_m: float) -> list[dict]:
    """All SSR names in the box: 3x3 circles of SSR_RADIUS_M (the API's maximum), deduped by stedsnummer."""
    step = half_m * 2 / 3
    names: dict[int, dict] = {}
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            lon, lat = unproject_local(dj * step, di * step, lon0, lat0)
            for page in range(1, 80):
                url = (
                    f"{SSR}?nord={lat:.5f}&ost={lon:.5f}&koordsys=4258&radius={SSR_RADIUS_M:.0f}"
                    f"&utkoordsys=4258&treffPerSide=200&side={page}"
                )
                d = json.loads(fetch(url, f"ssr/{lat:.5f}_{lon:.5f}_{page}.json"))
                for x in d["navn"]:
                    names[x["stedsnummer"]] = x
                if d["metadata"]["viserTil"] >= d["metadata"]["totaltAntallTreff"]:
                    break
    return list(names.values())


def main_name(entry: dict) -> str | None:
    cands = [s for s in entry.get("stedsnavn", []) if s.get("navnestatus") == "hovednavn"]
    cands.sort(key=lambda s: (s.get("språk") != "Norsk", s.get("stedsnavnnummer", 9)))
    return cands[0]["skrivemåte"] if cands else None


def pick_labels(names: list[dict], lon0: float, lat0: float, half_m: float) -> list[dict]:
    cands = []
    for e in names:
        spec = NAME_TYPES.get(e.get("navneobjekttype", ""))
        if not spec or e.get("stedstatus") != "aktiv":
            continue
        name = main_name(e)
        if not name or re.search(r"\s\d+$", name):  # "Tromsøysund 2" is the second tube, not a place
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
    # tier, then kind, then centre-out so the station's surroundings keep their names when the cap bites
    cands.sort(key=lambda c: (c["tier"], KIND_ORDER.index(c["kind"]), math.hypot(*c["xz"])))
    chosen: list[dict] = []
    per_kind: dict[str, int] = {}
    seen: set[str] = set()
    for c in cands:
        if len(chosen) >= MAX_LABELS or per_kind.get(c["kind"], 0) >= c["_cap"] or c["name"] in seen:
            continue
        # spacing thins a kind against itself; across kinds only a near-identical point is dropped, since
        # SSR puts "Tromsø" 60 m from Tromsøbrua and the page lifts each kind to its own height
        if any(
            math.hypot(c["xz"][0] - o["xz"][0], c["xz"][1] - o["xz"][1])
            < (c["_sp"] * 0.6 if o["kind"] == c["kind"] else CROSS_KIND_MIN_M)
            for o in chosen
        ):
            continue
        chosen.append(c)
        per_kind[c["kind"]] = per_kind.get(c["kind"], 0) + 1
        seen.add(c["name"])
    return [{k: v for k, v in c.items() if not k.startswith("_")} for c in chosen]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seed", type=Path, default=SEED)
    ap.add_argument("--station", action="append", default=[])
    a = ap.parse_args()
    _, stations = load_seed(a.seed.read_text())
    for s in stations:
        if a.station and s.station_id not in a.station:
            continue
        folder = a.out / "sites" / s.station_id
        road = json.loads((folder / "road.json").read_text())
        size_m = road["terrain"]["size_m"]
        cover = bake_cover(s.lon, s.lat, size_m)
        (folder / "cover.bin").write_bytes(cover.tobytes())
        labels = pick_labels(fetch_names(s.lon, s.lat, size_m / 2), s.lon, s.lat, size_m / 2)
        doc = {
            "n": COVER_N,
            "classes": CLASSES,
            "places": labels,
            "attribution": ["Land cover: NIBIO AR5 (CC BY 4.0)", "Place names: Kartverket (CC BY 4.0)"],
        }
        (folder / "places.json").write_text(json.dumps(doc, ensure_ascii=False) + "\n")
        counts = {name: int((cover == code).sum()) for name, code in CLASSES.items()}
        print(f"{s.station_id} {s.name}: {len(labels)} labels; cover {counts}")


if __name__ == "__main__":
    main()
