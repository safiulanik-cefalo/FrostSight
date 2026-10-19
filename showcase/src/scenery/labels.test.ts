import { describe, expect, it } from "vitest";
import type { Place } from "./assets";
import { fitLabels, labelBox, overlaps, tierFor } from "./labels";

const place = (name: string, kind: Place["kind"], tier: Place["tier"]): Place => ({ name, kind, tier, xz: [0, 0] });

describe("fitLabels", () => {
  const places = [place("Tromsø", "town", 1), place("Tromsøbrua", "bridge", 1), place("Fløya", "peak", 2), place("Langnes", "cape", 3)];

  it("keeps the earlier label when two collide on screen", () => {
    expect(fitLabels(places, [[400, 300], [405, 302], [700, 300], [900, 300]], 3)).toEqual([0, 2, 3]);
  });
  it("shows both when the camera separates them", () => {
    expect(fitLabels(places, [[400, 300], [400, 340], null, null], 3)).toEqual([0, 1]);
  });
  it("skips labels above the tier for the camera distance and those off screen", () => {
    expect(fitLabels(places, [[100, 100], [600, 100], [100, 500], [600, 500]], 1)).toEqual([0, 1]);
    expect(fitLabels(places, [null, [600, 100], [100, 500], [600, 500]], 2)).toEqual([1, 2]);
  });
  it("keeps labels out of a reserved box", () => {
    expect(fitLabels(places, [[400, 300], null, null, null], 3, [{ x: 350, y: 280, w: 100, h: 40 }])).toEqual([]);
  });
});

describe("labelBox and overlaps", () => {
  it("sizes a town wider than a district of the same length", () => {
    expect(labelBox(place("Abcdef", "town", 1), 0, 0).w).toBeGreaterThan(labelBox(place("Abcdef", "district", 1), 0, 0).w);
  });
  it("treats touching edges as apart", () => {
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 })).toBe(true);
  });
});

describe("tierFor", () => {
  it("shows more detail as the camera comes closer", () => {
    expect([tierFor(420), tierFor(200), tierFor(60)]).toEqual([1, 2, 3]);
  });
});
