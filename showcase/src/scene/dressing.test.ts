import { describe, it, expect } from "vitest";
import { treePlacements, isClosureIncident, TREELINE_M } from "./dressing";

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
