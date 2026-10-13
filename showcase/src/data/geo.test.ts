import { describe, it, expect } from "vitest";
import { nearestAlong, projectLocal } from "./geo";

const origin = { lat: 69, lon: 18 };

describe("projectLocal", () => {
  it("matches the bake script: metres east as x, metres south as z", () => {
    const [x0, z0] = projectLocal(69.01, 18, origin);
    expect(x0).toBeCloseTo(0);
    expect(z0).toBeCloseTo(-1105.74, 1);
    const [x1, z1] = projectLocal(69, 18.01, origin);
    expect(x1).toBeCloseTo(398.94, 1);
    expect(z1).toBeCloseTo(0);
  });
});

describe("nearestAlong", () => {
  const line: [number, number][] = [[0, 0], [25, 0], [50, 0], [75, 0]];
  it("gives the distance along the road and how far off it a point is", () => {
    const r = nearestAlong(line, 40, 10);
    expect(r.atM).toBeCloseTo(40);
    expect(r.offsetM).toBeCloseTo(10);
  });
  it("clamps to the ends of the road", () => {
    expect(nearestAlong(line, -30, 0)).toMatchObject({ atM: 0, offsetM: 30 });
    expect(nearestAlong(line, 100, 0).atM).toBeCloseTo(75);
  });
});
