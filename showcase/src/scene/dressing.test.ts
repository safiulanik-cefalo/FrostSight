import { describe, it, expect } from "vitest";
import { treePlacements, isClosureIncident, TREELINE_M, liveClosure, treelineAt } from "./dressing";

const low = () => 100;
const far = () => 50;

describe("treePlacements", () => {
  it("is deterministic for the same station", () => {
    expect(treePlacements("3000014", "coast", low, far, 300, 100)).toEqual(treePlacements("3000014", "coast", low, far, 300, 100));
    expect(treePlacements("3000014", "coast", low, far, 300, 100)).not.toEqual(treePlacements("3000016", "coast", low, far, 300, 100));
  });

  it("keeps trees off the road", () => {
    expect(treePlacements("x", "coast", low, () => 3, 300, 100)).toHaveLength(0);
    expect(treePlacements("x", "coast", low, far, 300, 100)).toHaveLength(100);
  });

  it("plants fewer trees in mountain and inland climates", () => {
    expect(treePlacements("x", "mountain", low, far, 300, 100)).toHaveLength(40);
    expect(treePlacements("x", "inland", low, far, 300, 100)).toHaveLength(70);
  });

  it("plants nothing above the treeline and smaller trees near it", () => {
    expect(treePlacements("x", "coast", () => TREELINE_M.coast + 10, far, 300, 100)).toHaveLength(0);
    const nearLine = treePlacements("x", "coast", () => TREELINE_M.coast - 10, far, 300, 50);
    const valley = treePlacements("x", "coast", () => 0.5 * TREELINE_M.coast, far, 300, 50);
    expect(Math.max(...nearLine.map((t) => t.s))).toBeLessThan(Math.min(...valley.map((t) => t.s)) + 0.01);
  });

  it("stays inside the plate", () => {
    for (const t of treePlacements("x", "coast", low, far, 300, 200)) {
      expect(Math.abs(t.x)).toBeLessThanOrEqual(150);
      expect(Math.abs(t.z)).toBeLessThanOrEqual(150);
    }
  });
});

describe("isClosureIncident", () => {
  it("recognises DATEX closure types", () => {
    expect(isClosureIncident("roadClosed")).toBe(true);
    expect(isClosureIncident("Road closure")).toBe(true);
    expect(isClosureIncident("accident")).toBe(false);
  });
});

import { closureLabel, isSimulatedIncident } from "./dressing";

describe("closureLabel", () => {
  it("states a scenario's stretch but never invents one for a live closure", () => {
    expect(closureLabel({ start_m: 5000, end_m: 7000, simulated: true }, "Gardeborri")).toBe("Road closed · km 5 to 7");
    expect(closureLabel({ start_m: 0, end_m: 2000, simulated: false }, "Bossovarri")).toBe("Road closed near Bossovarri · position approximate");
  });
  it("recognises scenario incidents by one rule", () => {
    expect(isSimulatedIncident("sim-gardeborri-closed")).toBe(true);
    expect(isSimulatedIncident("NPRA_HBT_123")).toBe(false);
  });
});

describe("liveClosure", () => {
  it("closes 250 m either side of the incident's own spot on the road", () => {
    expect(liveClosure(6000, 3000, { atM: 4100, offsetM: 40 })).toEqual({ start_m: 3850, end_m: 4350, simulated: false, approximate: false });
    expect(liveClosure(6000, 3000, { atM: 100, offsetM: 40 })).toMatchObject({ start_m: 0, end_m: 350 });
  });
  it("falls back to 1 km either side of the station when the spot is unknown or off this road", () => {
    expect(liveClosure(6000, 3000, null)).toEqual({ start_m: 2000, end_m: 4000, simulated: false, approximate: true });
    expect(liveClosure(6000, 3000, { atM: 4100, offsetM: 1500 }).approximate).toBe(true);
  });
  it("labels an exact closure without the approximate warning", () => {
    expect(closureLabel({ start_m: 3850, end_m: 4350, simulated: false, approximate: false }, "Bossovarri")).toBe("Road closed here");
    expect(closureLabel({ start_m: 2000, end_m: 4000, simulated: false, approximate: true }, "Bossovarri")).toBe("Road closed near Bossovarri · position approximate");
  });
});

describe("treelineAt", () => {
  it("rises 70 m per degree south of 69°N, so southern hills keep their forest", () => {
    expect(treelineAt("warm", 69.2)).toBe(600);
    expect(treelineAt("inland", 61)).toBe(1110);
    expect(treelineAt("unknown", 69)).toBe(550);
  });
  it("lets trees grow higher on a southern site", () => {
    const at800 = () => 800;
    const far = () => 50;
    expect(treePlacements("x", "inland", at800, far, 300, 100, 69)).toHaveLength(0);
    expect(treePlacements("x", "inland", at800, far, 300, 100, 61)).toHaveLength(70);
  });
});
