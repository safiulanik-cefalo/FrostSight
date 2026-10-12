import { describe, it, expect } from "vitest";
import { stretches, pointAt } from "./corridor";

describe("stretches", () => {
  it("cuts the corridor into 2 km stretches and colours those within 5 km of the station", () => {
    const s = stretches(11000, 6000, "HIGH", []);
    expect(s.map((x) => x.end_m)).toEqual([2000, 4000, 6000, 8000, 10000, 11000]);
    expect(s.every((x) => x.level === "HIGH")).toBe(true);
    expect(stretches(14000, 2000, "HIGH", []).map((x) => x.level)).toEqual(["HIGH", "HIGH", "HIGH", "HIGH", "NONE", "NONE", "NONE"]);
  });

  it("shows no coverage everywhere when the station has no current risk", () => {
    expect(stretches(12000, 6000, null, []).every((x) => x.level === "NONE")).toBe(true);
  });

  it("marks exactly the stretches a closure overlaps", () => {
    const s = stretches(12000, 6000, "HIGH", [{ start_m: 2000, end_m: 4000, simulated: true }]);
    expect(s.map((x) => x.closed)).toEqual([false, true, false, false, false, false]);
    expect(s[1].simulated).toBe(true);
    expect(s[0].simulated).toBe(false);
  });

  it("covers a corridor shorter than one stretch", () => {
    expect(stretches(950, 0, "LOW", [])).toEqual([{ start_m: 0, end_m: 950, level: "LOW", closed: false, simulated: false }]);
  });
});

describe("pointAt", () => {
  it("interpolates position and unit tangent along evenly spaced points", () => {
    expect(pointAt([[0, 0], [25, 0], [50, 0]], 30)).toEqual({ x: 30, z: 0, tx: 1, tz: 0 });
    expect(pointAt([[0, 0], [0, 25]], 100)).toEqual({ x: 0, z: 25, tx: 0, tz: 1 });
  });
});
