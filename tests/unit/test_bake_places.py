"""Pure functions of the showcase places bake (showcase/tools/bake_places.py)."""

import importlib.util
import sys
from pathlib import Path

import numpy as np
from pyproj import Transformer

_TOOLS = Path(__file__).resolve().parents[2] / "showcase" / "tools"
sys.path.insert(0, str(_TOOLS))
_spec = importlib.util.spec_from_file_location("bake_places", _TOOLS / "bake_places.py")
bp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bp)

LON0, LAT0 = 18.96943, 69.67681  # Tverrforbindelsen øst, Tromsø


def ssr(name: str, kind: str, x: float, z: float, *, status: str = "aktiv", others=()) -> dict:
    lon, lat = bp.unproject_local(x, z, LON0, LAT0)
    names = [
        {"skrivemåte": name, "navnestatus": "hovednavn", "språk": "Norsk", "stedsnavnnummer": 1},
        *others,
    ]
    return {
        "navneobjekttype": kind,
        "stedstatus": status,
        "stedsnavn": names,
        "representasjonspunkt": {"nord": lat, "øst": lon},
        "stedsnummer": hash((name, x, z)),
    }


def test_classify_maps_legend_colours_and_antialiased_edges():
    rgb = np.array([[[252, 219, 214], [204, 254, 254], [250, 220, 215], [255, 255, 255]]], dtype=np.uint8)
    assert bp.classify(rgb, bp.AREALTYPE).tolist() == [[bp.BUILT, bp.SEA, bp.BUILT, bp.UNMAPPED]]


def test_merge_species_splits_forest_only():
    areal = np.array([bp.FOREST_MIXED, bp.FOREST_MIXED, bp.FOREST_MIXED, bp.BUILT], dtype=np.uint8)
    tres = np.array([bp.FOREST_CONIFER, bp.FOREST_LEAF, bp.OPEN, bp.FOREST_LEAF], dtype=np.uint8)
    assert bp.merge_species(areal, tres).tolist() == [
        bp.FOREST_CONIFER,
        bp.FOREST_LEAF,
        bp.FOREST_MIXED,
        bp.BUILT,
    ]


def test_majority_weights_bog_stripes_over_white():
    row = [bp.BOG] * 8 + [bp.UNMAPPED] * 17  # stripes cover about a third of a bog cell
    assert bp.majority(np.array([row])).tolist() == [bp.BOG]
    assert bp.majority(np.array([[bp.FARM] * 13 + [bp.OPEN] * 12])).tolist() == [bp.FARM]


def test_unproject_local_arr_matches_the_scalar_projection():
    x, z = np.array([-7000.0, 0.0, 3500.0]), np.array([7000.0, 0.0, -1200.0])
    lon, lat = bp.unproject_local_arr(x, z, LON0, LAT0)
    for i in range(3):
        assert np.allclose((lon[i], lat[i]), bp.unproject_local(float(x[i]), float(z[i]), LON0, LAT0))


def test_cover_grid_puts_north_in_row_zero_and_east_in_the_last_column():
    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)
    ex, ey = to_utm.transform(LON0, LAT0)
    half = 8000.0
    bbox = (ex - half, ey - half, ex + half, ey + half)
    img = np.full((64, 64), bp.OPEN, dtype=np.uint8)
    img[:16, :] = bp.SEA  # the north quarter of the image
    img[:, 48:] = bp.BUILT  # the east quarter
    g = bp.cover_grid(img, bbox, LON0, LAT0, 14000.0, to_utm, n=16)
    assert g[0, 4] == bp.SEA and g[15, 4] == bp.OPEN
    assert g[8, 15] == bp.BUILT and g[8, 0] == bp.OPEN


def test_main_name_prefers_norwegian_main_name():
    sami = {"skrivemåte": "Romsa", "navnestatus": "hovednavn", "språk": "Nordsamisk", "stedsnavnnummer": 2}
    old = {"skrivemåte": "Tromsøe", "navnestatus": "historisk", "språk": "Norsk", "stedsnavnnummer": 3}
    assert bp.main_name(ssr("Tromsø", "By", 0, 0, others=[sami, old])) == "Tromsø"
    assert bp.main_name({"stedsnavn": [old]}) is None
    side = [
        {"skrivemåte": "Fossbergom", "navnestatus": "sidenavn", "språk": "Norsk", "stedsnavnnummer": 2},
        {"skrivemåte": "Lom", "navnestatus": "sidenavn", "språk": "Norsk", "stedsnavnnummer": 1},
    ]
    assert bp.main_name({"stedsnavn": side}) == "Lom"


def test_pick_labels_keeps_known_kinds_ranked_and_drops_the_rest():
    names = [
        ssr("Fløya", "Fjell", 2000, 1000),
        ssr("Tromsø", "By", 300, 2000),
        ssr("Tromsøbrua", "Bru", 260, 2050),  # 60 m from the town point: both kept
        ssr("Storgata", "Adressenavn", 0, 0),
        ssr("Gammelbrua", "Bru", 900, 900, status="historisk"),
        ssr("Tromsøysund 2", "Tunnel", 100, 100),
        ssr("Bispelokket, Rampe opp fra Festningstunnelen", "Bru", 1500, 300),
        ssr("Sentrumstangentens østre nedkjøringsrampe", "Tunnel", 900, 300),
        ssr("Furuset påkjøringsrampe", "Bru", 1200, -400),
        ssr("Langt borte", "By", 6900, 0),  # inside the box but on its rim
    ]
    labels = bp.pick_labels(names, LON0, LAT0, 7000.0)
    assert [(p["name"], p["kind"], p["tier"]) for p in labels] == [
        ("Tromsø", "town", 1),
        ("Tromsøbrua", "bridge", 1),
        ("Fløya", "peak", 2),
    ]
    assert labels[0]["xz"] == [300, 2000]


def test_pick_labels_thins_a_kind_by_spacing_and_cap():
    peaks = [ssr(f"Tind {chr(ord('a') + i + 20)}", "Fjell", i * 300.0, 0) for i in range(-20, 21)]
    labels = bp.pick_labels(peaks, LON0, LAT0, 7000.0)
    xs = sorted(p["xz"][0] for p in labels)
    assert len(labels) == bp.NAME_TYPES["Fjell"][3]
    assert min(b - a for a, b in zip(xs, xs[1:], strict=False)) >= bp.NAME_TYPES["Fjell"][2] * 0.6
    assert labels[0]["xz"] == [0, 0]  # centre-out within a kind


def test_pick_labels_names_the_model_of_a_landmark_by_its_ssr_type():
    names = [
        ssr("Ishavskatedralen", "Kirke", 500, 500),  # no "kirke" in the name; the type still says church
        ssr("UNN Tromsø", "Sykehus", -2000, 1500),
        ssr("UiT Tromsø", "Universitet/høgskole", 2500, -2500),
        ssr("Tromsø", "By", 0, 0),
    ]
    by_name = {p["name"]: p for p in bp.pick_labels(names, LON0, LAT0, 7000.0)}
    assert by_name["Ishavskatedralen"]["model"] == "church"
    assert by_name["UNN Tromsø"]["model"] == "hospital"
    assert by_name["UiT Tromsø"]["model"] == "campus"
    assert "model" not in by_name["Tromsø"]
