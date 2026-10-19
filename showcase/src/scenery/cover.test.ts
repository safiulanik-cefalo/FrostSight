import { describe, expect, it } from "vitest";
import { COVER, builtDensity, coverAt, decodeCover, type CoverGrid } from "./cover";

/** 3 x 3 grid over 1,400 m: row 0 is north (z = -700), column 0 is west (x = -700). */
function grid(rows: number[][]): CoverGrid {
  return { n: rows.length, cells: Uint8Array.from(rows.flat()), sizeM: 1400 };
}

describe("coverAt", () => {
  const g = grid([
    [COVER.SEA, COVER.SEA, COVER.SEA],
    [COVER.FARM, COVER.BUILT, COVER.OPEN],
    [COVER.BOG, COVER.FOREST_LEAF, COVER.FOREST_CONIFER],
  ]);
  it("reads north at negative z and east at positive x", () => {
    expect(coverAt(g, 0, -700)).toBe(COVER.SEA);
    expect(coverAt(g, 0, 0)).toBe(COVER.BUILT);
    expect(coverAt(g, 700, 0)).toBe(COVER.OPEN);
    expect(coverAt(g, -700, 700)).toBe(COVER.BOG);
  });
  it("clamps outside the box", () => {
    expect(coverAt(g, 5000, 5000)).toBe(COVER.FOREST_CONIFER);
  });
});

describe("decodeCover", () => {
  it("takes the side from the byte count", () => {
    const g = decodeCover(new Uint8Array(16).buffer, 14000);
    expect(g.n).toBe(4);
    expect(g.sizeM).toBe(14000);
  });
});

describe("builtDensity", () => {
  it("is 1 inside a block of built cells and lower at its edge", () => {
    const B = COVER.BUILT;
    const g = grid([
      [B, B, B],
      [B, B, B],
      [B, B, COVER.SEA],
    ]);
    expect(builtDensity(g, 1, 1)).toBeCloseTo(8 / 9);
    expect(builtDensity(grid([[B, B, B], [B, B, B], [B, B, B]]), 1, 1)).toBe(1);
    expect(builtDensity(g, 0, 0)).toBeCloseTo(4 / 9);
  });
});
