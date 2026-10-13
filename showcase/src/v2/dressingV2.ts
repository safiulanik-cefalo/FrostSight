// SPIKE (throwaway): pure placement and colour rules driven by the land-cover grid. Terrain vertex colours,
// trees by forest type, houses in built-up cells. No Three.js objects here.
import * as THREE from "three";
import { PALETTE } from "../scene/geometry";
import { rng, treelineAt } from "../scene/dressing";
import { COVER, builtDensity, coverAt, isForest, type CoverGrid } from "./cover";

export const COVER_PALETTE = {
  built: "#d9d3cd",
  builtSnow: "#e4e1e2",
  farm: "#e2e6c3",
  forest: "#c3d7c1",
  bog: "#d2d9ca",
  birch: "#8ab87e",
  wallWhite: "#ece6dc",
  wallRed: "#b9584a",
  wallOchre: "#d7b263",
  wallBlue: "#8ea3b9",
  roof: "#5a5a62",
} as const;

/** The ground colour for a cover class, or null where the height rule (rock, snow, water) stays. */
export function coverColor(cover: number, snowline: boolean): string | null {
  switch (cover) {
    case COVER.FRESHWATER:
    case COVER.SEA:
      return PALETTE.water;
    case COVER.BUILT:
    case COVER.ROAD:
      return snowline ? COVER_PALETTE.builtSnow : COVER_PALETTE.built;
    case COVER.FARM:
      return snowline ? PALETTE.snowShade : COVER_PALETTE.farm;
    case COVER.FOREST_LEAF:
    case COVER.FOREST_CONIFER:
    case COVER.FOREST_MIXED:
      return snowline ? PALETTE.snowShade : COVER_PALETTE.forest;
    case COVER.BOG:
      return snowline ? PALETTE.snowShade : COVER_PALETTE.bog;
    default:
      return null;
  }
}

const GENERIC = [new THREE.Color(PALETTE.grass), new THREE.Color(PALETTE.snowShade)];
const near = (r: number, g: number, b: number, c: THREE.Color) => Math.abs(r - c.r) + Math.abs(g - c.g) + Math.abs(b - c.b) < 0.01;

/** Recolour the generic ground vertices (grass, snow shade) of a v1 terrain geometry from the cover grid.
 *  Rock, snow and water from the height rule are kept. Lakes above sea level turn to water. */
export function applyCover(geometry: THREE.BufferGeometry, cover: CoverGrid, upm: number, snowline: boolean): void {
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const col = geometry.getAttribute("color") as THREE.BufferAttribute;
  const c = new THREE.Color();
  for (let v = 0; v < pos.count; v++) {
    const r = col.getX(v);
    const g = col.getY(v);
    const b = col.getZ(v);
    const klass = coverAt(cover, pos.getX(v) / upm, pos.getZ(v) / upm);
    const water = klass === COVER.FRESHWATER || klass === COVER.SEA;
    if (!water && !GENERIC.some((k) => near(r, g, b, k))) continue;
    const hex = coverColor(klass, snowline);
    if (!hex) continue;
    c.set(hex);
    col.setXYZ(v, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

export type TreeKind = "conifer" | "leaf";
export type TreeV2 = { x: number; z: number; s: number; kind: TreeKind };

/** Trees where the cover says forest (species from the cover), and at half density by the v1 treeline rule
 *  where AR5 has no mapping. Scene units in and out; the cover is read in metres. */
export function treePlacementsV2(
  seed: string,
  climate: string,
  lat: number,
  cover: CoverGrid,
  upm: number,
  heightM: (x: number, z: number) => number,
  distToRoad: (x: number, z: number) => number,
  size: number,
  count: number,
): TreeV2[] {
  const rand = rng(`${seed}:trees`);
  const treeline = treelineAt(climate, lat);
  const fallback: TreeKind = climate === "inland" || climate === "warm" ? "conifer" : "leaf";
  const out: TreeV2[] = [];
  for (let tries = 0; out.length < count && tries < count * 40; tries++) {
    const x = (rand() - 0.5) * size;
    const z = (rand() - 0.5) * size;
    const jitter = rand();
    const pick = rand();
    const h = heightM(x, z);
    if (h <= 1 || distToRoad(x, z) < 7) continue;
    const klass = coverAt(cover, x / upm, z / upm);
    let kind: TreeKind;
    if (isForest(klass)) {
      kind = klass === COVER.FOREST_CONIFER ? "conifer" : klass === COVER.FOREST_LEAF ? "leaf" : pick < 0.5 ? "conifer" : "leaf";
    } else if (klass === COVER.UNMAPPED && h < treeline && pick < 0.5) {
      kind = fallback;
    } else {
      continue;
    }
    out.push({ x, z, s: (0.85 + jitter * 0.3) * (1.1 - (0.7 * Math.min(h, treeline)) / treeline), kind });
  }
  return out;
}

export type House = { x: number; z: number; yaw: number; w: number; d: number; h: number; wall: string; dense: boolean };
const WALLS = [COVER_PALETTE.wallWhite, COVER_PALETTE.wallWhite, COVER_PALETTE.wallRed, COVER_PALETTE.wallOchre, COVER_PALETTE.wallBlue];

/** Up to `cap` toy houses spread over the built-up cells; blocks grow where every neighbour is built too. */
export function housePlacements(seed: string, cover: CoverGrid, upm: number, distToRoad: (x: number, z: number) => number, cap: number): House[] {
  const rand = rng(`${seed}:houses`);
  let built = 0;
  for (const c of cover.cells) if (c === COVER.BUILT) built++;
  if (built === 0) return [];
  const p = Math.min(1, cap / built);
  const cellM = cover.sizeM / (cover.n - 1);
  const out: House[] = [];
  for (let i = 0; i < cover.n; i++) {
    for (let j = 0; j < cover.n; j++) {
      if (cover.cells[i * cover.n + j] !== COVER.BUILT || rand() > p) continue;
      const xM = (j / (cover.n - 1) - 0.5) * cover.sizeM + (rand() - 0.5) * cellM * 0.8;
      const zM = (i / (cover.n - 1) - 0.5) * cover.sizeM + (rand() - 0.5) * cellM * 0.8;
      const x = xM * upm;
      const z = zM * upm;
      if (distToRoad(x, z) < 7) continue;
      const dense = builtDensity(cover, i, j) >= 0.99 && rand() < 0.5;
      const k = rand();
      out.push({
        x,
        z,
        yaw: rand() * Math.PI,
        w: dense ? 2.2 + k * 1.2 : 1.3 + k * 0.7,
        d: dense ? 1.8 + rand() * 1.0 : 1.1 + rand() * 0.6,
        h: dense ? 2.4 + rand() * 1.6 : 1.1 + rand() * 0.6,
        wall: dense ? COVER_PALETTE.wallWhite : WALLS[Math.floor(rand() * WALLS.length)],
        dense,
      });
    }
  }
  return out;
}
