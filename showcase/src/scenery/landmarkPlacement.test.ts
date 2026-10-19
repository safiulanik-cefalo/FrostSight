import { describe, it, expect } from "vitest";
import { placeLandmarks } from "./landmarkPlacement";
import type { Place } from "./assets";

// 300 units over 15 km: 0.02 units per metre; the ground rises 1 unit per 10 units east
const site = { upm: 0.02, ground: (x: number) => x / 10 };

const place = (p: Partial<Place>): Place => ({ name: "Lom stavkyrkje", kind: "landmark", tier: 3, xz: [1000, -500], model: "church", ...p });

describe("placeLandmarks", () => {
  it("stands each landmark's model on the ground under its label", () => {
    expect(placeLandmarks([place({})], site, 150)).toEqual([
      { key: "Lom stavkyrkje", model: "church", x: 20, z: -10, y: 2 - 0.1, yaw: expect.any(Number) },
    ]);
  });

  it("draws only places the bake gave a model", () => {
    const town = place({ name: "Lom", kind: "town", tier: 1, model: undefined });
    expect(placeLandmarks([town, place({ name: "Fossbergom kyrkje", model: undefined })], site, 150)).toEqual([]);
  });

  it("leaves out a landmark off the plate", () => {
    expect(placeLandmarks([place({ xz: [8000, 0] })], site, 150)).toEqual([]);
  });

  it("turns the same landmark the same way every visit, and different ones differently", () => {
    const [a] = placeLandmarks([place({})], site, 150);
    const [b] = placeLandmarks([place({})], site, 150);
    const [c] = placeLandmarks([place({ name: "Vågå kyrkje" })], site, 150);
    expect(a.yaw).toBe(b.yaw);
    expect(a.yaw).not.toBe(c.yaw);
  });
});
