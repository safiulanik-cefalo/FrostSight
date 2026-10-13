"""Pure functions of the showcase bake script (showcase/tools/bake_sites.py)."""

import importlib.util
import math
import sys
from pathlib import Path

import numpy as np
import pytest

_PATH = Path(__file__).resolve().parents[2] / "showcase" / "tools" / "bake_sites.py"
_spec = importlib.util.spec_from_file_location("bake_sites", _PATH)
bake = importlib.util.module_from_spec(_spec)
sys.modules["bake_sites"] = bake
_spec.loader.exec_module(bake)

SEED_EXCERPT = """
INSERT INTO frostsight.mock.seed_roads VALUES
('E', '8', 0, 1200, 'LINESTRING (20.74 69.11, 20.745 69.12, 20.75 69.13)');
INSERT INTO frostsight.mock.seed_stations VALUES
('3000014', 'Bossovarri', 'E', '8', 69.12020, 20.74511, 'mountain', 0, '1125788-27-9');
"""


def test_parse_wkt_linestring():
    assert bake.parse_wkt_linestring("LINESTRING (17.694 68.65267, 17.705 68.654)") == [
        (17.694, 68.65267),
        (17.705, 68.654),
    ]


def test_load_seed_reads_roads_and_stations():
    roads, stations = bake.load_seed(SEED_EXCERPT)
    assert len(roads) == 1 and roads[0].road_category == "E" and roads[0].road_number == "8"
    assert roads[0].line_no == 0 and len(roads[0].points) == 3
    s = stations[0]
    assert (s.station_id, s.name, s.climate) == ("3000014", "Bossovarri", "mountain")
    assert s.road_segment_id == "1125788-27-9"
    assert (s.lat, s.lon) == (69.1202, 20.74511)
    assert bake.road_label(s.road_category, s.road_number) == "E8"
    assert bake.road_label("F", "91") == "Fv91"


SEED_WITH_COUNTY = """
INSERT INTO frostsight.mock.seed_roads VALUES
('E', '6', 3, 900, 'LINESTRING (10.76 59.91, 10.77 59.92)', 'Oslo');
INSERT INTO frostsight.mock.seed_stations VALUES
('1100000', 'Ryen', 'E', '6', 59.89, 10.80, 'warm', 0, '1-2-3', 'Oslo'),
('1200000', 'Mjøsbrua', 'E', '6', 60.92, 10.69, 'inland', 0, '4-5-6', 'Innlandet');
"""


def test_load_seed_reads_the_county_and_defaults_old_rows_to_troms():
    roads, stations = bake.load_seed(SEED_WITH_COUNTY)
    assert [(r.line_no, r.county) for r in roads] == [(3, "Oslo")]
    assert [(s.station_id, s.county) for s in stations] == [("1100000", "Oslo"), ("1200000", "Innlandet")]
    old_roads, old_stations = bake.load_seed(SEED_EXCERPT)
    assert old_roads[0].county == "Troms" and old_stations[0].county == "Troms"


def test_regions_group_counties_for_the_overview():
    assert [r["id"] for r in bake.REGIONS] == ["troms", "oslo-akershus", "innlandet"]
    assert bake.region_of("Oslo") == "oslo-akershus" and bake.region_of("Akershus") == "oslo-akershus"
    assert bake.region_of("Troms") == "troms" and bake.region_of("Innlandet") == "innlandet"
    oslo = next(r for r in bake.REGIONS if r["id"] == "oslo-akershus")
    assert oslo["fylker"] == ["03", "32"] and oslo["name"] == "Oslo and Akershus"


def test_project_local_east_positive_north_negative():
    x, z = bake.project_local(20.75, 69.13, 20.74511, 69.1202)
    expected_x = 0.00489 * math.cos(math.radians(69.1202)) * 111320
    assert x == pytest.approx(expected_x, rel=0.02)
    assert z < 0


def _straight(length_m: float, step: float = 100.0):
    return [(i * step, 0.0) for i in range(int(length_m / step) + 1)]


def test_cut_corridor_clamps_at_the_far_end():
    pts = _straight(20000)
    idx = bake.nearest_index(pts, (15000.0, 30.0))
    out, at = bake.cut_corridor(pts, idx)
    assert at == pytest.approx(6000)
    assert bake.cumulative_m(out)[-1] == pytest.approx(11000)
    gaps = np.diff(bake.cumulative_m(out))
    assert np.allclose(gaps, 25.0, atol=0.01)


def test_cut_corridor_clamps_at_the_near_end():
    pts = _straight(20000)
    out, at = bake.cut_corridor(pts, bake.nearest_index(pts, (2000.0, 0.0)))
    assert at == pytest.approx(2000)
    assert bake.cumulative_m(out)[-1] == pytest.approx(8000)


def test_pick_road_chooses_the_nearest_line_of_the_same_road():
    roads, stations = bake.load_seed(SEED_EXCERPT)
    far = bake.Road("E", "8", 1, [(21.5, 69.6), (21.6, 69.7)])
    other = bake.Road("E", "6", 0, [(20.745, 69.12)])
    assert bake.pick_road([far, other, *roads], stations[0]).line_no == 0


def test_decode_terrarium():
    rgb = np.array([[[128, 0, 0], [129, 0, 0]]], dtype=np.uint8)
    assert bake.decode_terrarium(rgb).tolist() == [[0.0, 256.0]]


def test_tile_xy():
    assert bake.tile_xy(0.0, 0.0, 1) == (1, 1)
    assert bake.tile_xy(20.745, 69.12, 11) == (1142, 472)


def test_resample_box_is_north_row_first():
    hm = bake.resample_box(lambda lon, lat: lat * 1000, (20.0, 69.0), size_m=1000.0, n=3)
    assert hm.shape == (3, 3)
    assert hm[0, 1] > hm[2, 1]


def test_encode_heights():
    data, lo, hi = bake.encode_heights(np.array([[0.0, 100.0]]))
    assert data == bytes([0x00, 0x00, 0xFF, 0xFF])
    assert (lo, hi) == (0.0, 100.0)


def test_simplify_drops_a_small_bump():
    assert bake.simplify([(0.0, 0.0), (50.0, 1.0), (100.0, 0.0)], 10.0) == [(0.0, 0.0), (100.0, 0.0)]
    assert len(bake.simplify([(0.0, 0.0), (50.0, 40.0), (100.0, 0.0)], 10.0)) == 3


def test_chain_lines_joins_touching_pieces_in_either_direction():
    a = [(20.00, 69.0), (20.01, 69.0)]
    b = [(20.01, 69.0), (20.02, 69.0)]
    c = [(20.00, 69.0), (19.99, 69.0)]  # touches a's start, stored the other way round
    far = [(21.0, 69.5), (21.1, 69.5)]
    assert bake.chain_lines([a, b, c, far], 0) == [(19.99, 69.0), (20.0, 69.0), (20.01, 69.0), (20.02, 69.0)]
