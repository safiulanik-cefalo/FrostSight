// Pure geometry for the dioramas: terrain from a heightmap, ribbons along the road, terrain colours.
// Positions are scene units; heights in the heightmap are metres.
import * as THREE from "three";

export const PALETTE = {
  sky: "#dfe8f6",
  skyCold: "#c9d6ea",
  snow: "#f4f7fb",
  snowShade: "#e3eaf4",
  rock: "#8a97ad",
  rockDark: "#6c7a93",
  grass: "#cfe0d2",
  water: "#a9c4e4",
  asphalt: "#4d5668",
  shoulder: "#e9eef5",
  dash: "#fff6d6",
  tree: "#4f9a6b",
  trunk: "#8a6a4e",
  accent: "#2f62e6",
} as const;

/** Bilinear height in metres at scene-centred (x, z) in the heightmap's own units; north (row 0) is -z. */
export function heightAt(heights: Float32Array, n: number, size: number, x: number, z: number): number {
  const cell = size / (n - 1);
  const fx = Math.max(0, Math.min(n - 1, (x + size / 2) / cell));
  const fz = Math.max(0, Math.min(n - 1, (z + size / 2) / cell));
  const j0 = Math.min(n - 2, Math.floor(fx));
  const i0 = Math.min(n - 2, Math.floor(fz));
  const tx = fx - j0;
  const tz = fz - i0;
  const h = (i: number, j: number) => heights[i * n + j];
  const top = h(i0, j0) * (1 - tx) + h(i0, j0 + 1) * tx;
  const bottom = h(i0 + 1, j0) * (1 - tx) + h(i0 + 1, j0 + 1) * tx;
  return top * (1 - tz) + bottom * tz;
}

function cumulative(points: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return out;
}

function sampleAt(points: [number, number][], cum: number[], s: number): { x: number; z: number; tx: number; tz: number } {
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < s) i++;
  const [x0, z0] = points[i];
  const [x1, z1] = points[i + 1];
  const len = cum[i + 1] - cum[i] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i]) / len));
  return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, tx: (x1 - x0) / len, tz: (z1 - z0) / len };
}

/** A flat strip along the line, halfWidth either side, lifted above the ground; optionally only [from, to]. */
export function ribbonGeometry(
  points: [number, number][],
  heightFn: (x: number, z: number, s: number) => number,
  halfWidth: number,
  lift: number,
  from?: number,
  to?: number,
): THREE.BufferGeometry {
  const cum = cumulative(points);
  const a = from ?? 0;
  const b = to ?? cum[cum.length - 1];
  const stations = [a, ...cum.filter((c) => c > a + 1e-6 && c < b - 1e-6), b];
  const pos: number[] = [];
  const idx: number[] = [];
  stations.forEach((s, k) => {
    const p = sampleAt(points, cum, s);
    const nx = -p.tz;
    const nz = p.tx;
    const y = heightFn(p.x, p.z, s) + lift;
    pos.push(p.x + nx * halfWidth, y, p.z + nz * halfWidth, p.x - nx * halfWidth, y, p.z - nz * halfWidth);
    if (k < stations.length - 1) {
      const v = k * 2;
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function terrainColor(hM: number, slopeDeg: number, snowline: boolean): string {
  if (hM <= 1) return PALETTE.water;
  if (hM > 300 && slopeDeg > 42) return PALETTE.rockDark;
  if (hM > 300 && slopeDeg > 30) return PALETTE.rock;
  if (hM > 800) return PALETTE.snow;
  if (!snowline && hM < 600) return PALETTE.grass;
  return PALETTE.snowShade;
}

/** n x n terrain, size scene units wide, y = (h - min) x exaggeration x unitsPerMetre, coloured per vertex. */
export function terrainGeometry(
  heights: Float32Array,
  n: number,
  size: number,
  exaggeration: number,
  unitsPerMetre: number,
  snowline: boolean,
): THREE.BufferGeometry {
  let min = Infinity;
  for (const h of heights) min = Math.min(min, h);
  const cell = size / (n - 1);
  const cellM = cell / unitsPerMetre;
  const pos = new Float32Array(n * n * 3);
  const col = new Float32Array(n * n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      const h = heights[k];
      pos[k * 3] = -size / 2 + j * cell;
      pos[k * 3 + 1] = (h - min) * exaggeration * unitsPerMetre;
      pos[k * 3 + 2] = -size / 2 + i * cell;
      const dx = heights[i * n + Math.min(n - 1, j + 1)] - heights[i * n + Math.max(0, j - 1)];
      const dz = heights[Math.min(n - 1, i + 1) * n + j] - heights[Math.max(0, i - 1) * n + j];
      const slope = (Math.atan(Math.hypot(dx, dz) / (2 * cellM)) * 180) / Math.PI;
      c.set(terrainColor(h, slope, snowline));
      col.set([c.r, c.g, c.b], k * 3);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
