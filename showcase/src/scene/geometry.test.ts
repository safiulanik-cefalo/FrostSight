import { describe, it, expect } from "vitest";
import { heightAt, ribbonGeometry, terrainGeometry, terrainColor, PALETTE } from "./geometry";

describe("heightAt", () => {
  it("interpolates bilinearly with the origin at the grid centre and north as row 0", () => {
    const h = new Float32Array([0, 100, 0, 100]); // row 0 (north): 0 100, row 1 (south): 0 100
    expect(heightAt(h, 2, 100, 0, 0)).toBeCloseTo(50);
    expect(heightAt(h, 2, 100, -50, -50)).toBeCloseTo(0);
    const ns = new Float32Array([10, 10, 30, 30]);
    expect(heightAt(ns, 2, 100, 0, -50)).toBeCloseTo(10); // north edge
    expect(heightAt(ns, 2, 100, 0, 500)).toBeCloseTo(30); // clamped beyond the south edge
  });
});

describe("ribbonGeometry", () => {
  const line: [number, number][] = [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]];
  it("puts two vertices per sample, halfWidth either side of the centre line", () => {
    const g = ribbonGeometry(line, () => 0, 3, 0.5);
    const p = g.getAttribute("position");
    expect(p.count).toBe(10);
    const a = [p.getX(0), p.getY(0), p.getZ(0)];
    const b = [p.getX(1), p.getY(1), p.getZ(1)];
    expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeCloseTo(6);
    expect(a[1]).toBeCloseTo(0.5);
  });
  it("cuts a part of the line between two distances", () => {
    const g = ribbonGeometry(line, (_x, _z, s) => s / 10, 3, 0, 10, 60);
    const p = g.getAttribute("position");
    expect(p.count).toBe(2 * 4); // 10, 25, 50, 60
    expect(p.getX(0)).toBeCloseTo(10);
    expect(p.getX(p.count - 1)).toBeCloseTo(60);
    expect(p.getY(0)).toBeCloseTo(1); // height taken from distance along the line
    expect(p.getY(p.count - 1)).toBeCloseTo(6);
  });
});

describe("terrainGeometry", () => {
  it("raises the highest sample to exaggeration x relief x scale", () => {
    const h = new Float32Array([100, 200, 300, 1100]);
    const g = terrainGeometry(h, 2, 300, 1.6, 0.02, true);
    const p = g.getAttribute("position");
    const ys = Array.from({ length: p.count }, (_, i) => p.getY(i));
    expect(Math.max(...ys)).toBeCloseTo(1.6 * 1000 * 0.02);
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(g.getAttribute("color").count).toBe(4);
  });
});

describe("terrainColor", () => {
  it("shows rock on steep high ground, snow elsewhere, grass low down in a thaw, water at sea level", () => {
    expect(terrainColor(950, 35, true)).toBe(PALETTE.rock);
    expect(terrainColor(400, 35, true)).toBe(PALETTE.rock);
    expect(terrainColor(400, 50, true)).toBe(PALETTE.rockDark);
    expect(terrainColor(200, 35, true)).toBe(PALETTE.snowShade);
    expect(terrainColor(950, 10, true)).toBe(PALETTE.snow);
    expect(terrainColor(300, 10, true)).toBe(PALETTE.snowShade);
    expect(terrainColor(300, 10, false)).toBe(PALETTE.grass);
    expect(terrainColor(700, 10, false)).toBe(PALETTE.snowShade);
    expect(terrainColor(0, 0, true)).toBe(PALETTE.water);
  });
});
