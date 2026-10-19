import { describe, expect, it } from "vitest";
import { PALETTE } from "../scene/geometry";
import { COVER, coverAt, type CoverGrid } from "./cover";
import { COVER_PALETTE, HOUSE_CAP, coverColor, coverTreePlacements, houseBudget, housePlacements } from "./scenery";

const N = 32;
const SIZE_M = 3200;
const UPM = 300 / SIZE_M; // scene units per metre, as on a site plate
/** West half one class, east half another. */
function halves(west: number, east: number): CoverGrid {
  const cells = new Uint8Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) cells[i * N + j] = j < N / 2 ? west : east;
  return { n: N, cells, sizeM: SIZE_M };
}
const flat = () => 50;
const farFromRoad = () => 100;

describe("coverColor", () => {
  it("paints water, built-up and farmland, and leaves open and unmapped land to the height rule", () => {
    expect(coverColor(COVER.SEA, true)).toBe(PALETTE.water);
    expect(coverColor(COVER.FRESHWATER, false)).toBe(PALETTE.water);
    expect(coverColor(COVER.BUILT, false)).toBe(COVER_PALETTE.built);
    expect(coverColor(COVER.FARM, false)).toBe(COVER_PALETTE.farm);
    expect(coverColor(COVER.OPEN, false)).toBeNull();
    expect(coverColor(COVER.UNMAPPED, true)).toBeNull();
  });
  it("puts snow on farmland and forest floor when the road is at or below freezing", () => {
    expect(coverColor(COVER.FARM, true)).toBe(PALETTE.snowShade);
    expect(coverColor(COVER.FOREST_LEAF, true)).toBe(PALETTE.snowShade);
  });
});

describe("coverTreePlacements", () => {
  it("places conifers on conifer forest and leaf trees on leaf forest, none on built-up land", () => {
    const g = halves(COVER.FOREST_CONIFER, COVER.FOREST_LEAF);
    const trees = coverTreePlacements("s", "fjord", 69.5, g, UPM, flat, farFromRoad, 300, 200);
    expect(trees.length).toBe(200);
    for (const t of trees) expect(t.kind).toBe(coverAt(g, t.x / UPM, t.z / UPM) === COVER.FOREST_CONIFER ? "conifer" : "leaf");
    expect(coverTreePlacements("s", "fjord", 69.5, halves(COVER.BUILT, COVER.SEA), UPM, flat, farFromRoad, 300, 50)).toEqual([]);
  });
  it("is the same for the same station", () => {
    const g = halves(COVER.FOREST_MIXED, COVER.UNMAPPED);
    const a = coverTreePlacements("1900175", "fjord", 69.4, g, UPM, flat, farFromRoad, 300, 80);
    expect(coverTreePlacements("1900175", "fjord", 69.4, g, UPM, flat, farFromRoad, 300, 80)).toEqual(a);
  });
  it("keeps trees off the road and out of the sea", () => {
    const g = halves(COVER.FOREST_LEAF, COVER.FOREST_LEAF);
    expect(coverTreePlacements("s", "fjord", 69, g, UPM, flat, () => 3, 300, 20)).toEqual([]);
    expect(coverTreePlacements("s", "fjord", 69, g, UPM, () => 0, farFromRoad, 300, 20)).toEqual([]);
  });
});

describe("houseBudget", () => {
  it("keeps a house per cell in a village, about one in nine in a town and caps a city", () => {
    expect(houseBudget(90)).toBe(700);
    expect(houseBudget(6234)).toBe(700);
    expect(houseBudget(12000)).toBe(1320);
    expect(houseBudget(30728)).toBe(HOUSE_CAP);
  });
});

describe("housePlacements", () => {
  it("puts a house on every built-up cell of a village, and none elsewhere", () => {
    const g = halves(COVER.BUILT, COVER.FOREST_LEAF); // 512 built cells, under the 700 floor
    const houses = housePlacements("s", g, UPM, farFromRoad);
    expect(houses.length).toBe((N * N) / 2);
    for (const h of houses) expect(h.x / UPM).toBeLessThan(SIZE_M / N); // within the west half, give or take a cell
  });
  it("builds nothing without built-up land", () => {
    expect(housePlacements("s", halves(COVER.FARM, COVER.SEA), UPM, farFromRoad)).toEqual([]);
  });
});
