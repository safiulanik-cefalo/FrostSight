// Everything a site's components share, derived once from the baked assets: scaled road, height function.
import { heightAt } from "./geometry";
import { SITE_EXAGGERATION, siteUnitsPerMetre } from "./scale";
import type { SiteAssets } from "../data/assets";

export type SiteModel = {
  upm: number;
  minM: number;
  /** ground height in scene units at scene (x, z) */
  ground: (x: number, z: number) => number;
  /** ground height in metres above sea level at scene (x, z) */
  groundM: (x: number, z: number) => number;
  /** distance in scene units from (x, z) to the road centre line, sampled every 50 m */
  distToRoad: (x: number, z: number) => number;
  /** road centre line in scene units, one point per 25 m */
  road: [number, number][];
  /** road surface height in scene units per road point, smoothed */
  roadY: number[];
  /** metres along the road to a scene position and tangent */
  at: (m: number) => { x: number; y: number; z: number; tx: number; tz: number };
  lengthM: number;
  stationAtM: number;
};

export function siteModel({ road, heights }: SiteAssets): SiteModel {
  const { n, size_m } = road.terrain;
  const upm = siteUnitsPerMetre(size_m);
  let minM = Infinity;
  for (const h of heights) minM = Math.min(minM, h);
  const groundM = (x: number, z: number) => heightAt(heights, n, size_m, x / upm, z / upm);
  const ground = (x: number, z: number) => (groundM(x, z) - minM) * SITE_EXAGGERATION * upm;
  const pts = road.points.map(([x, z]) => [x * upm, z * upm] as [number, number]);
  const raw = pts.map(([x, z]) => ground(x, z));
  const roadY = raw.map((_, i) => {
    let sum = 0;
    let k = 0;
    for (let d = -6; d <= 6; d++) {
      const v = raw[i + d];
      if (v !== undefined) {
        sum += v;
        k++;
      }
    }
    return sum / k;
  });
  const step = 25;
  const at = (m: number) => {
    const last = pts.length - 1;
    const f = Math.max(0, Math.min(last, m / step));
    const i = Math.min(last - 1, Math.floor(f));
    const t = f - i;
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0) || 1;
    return {
      x: x0 + (x1 - x0) * t,
      z: z0 + (z1 - z0) * t,
      y: roadY[i] * (1 - t) + roadY[i + 1] * t,
      tx: (x1 - x0) / len,
      tz: (z1 - z0) / len,
    };
  };
  const distToRoad = (x: number, z: number) => {
    let best = Infinity;
    for (let i = 0; i < pts.length; i += 2) best = Math.min(best, (pts[i][0] - x) ** 2 + (pts[i][1] - z) ** 2);
    return Math.sqrt(best);
  };
  return { upm, minM, ground, groundM, distToRoad, road: pts, roadY, at, lengthM: road.length_m, stationAtM: road.station_at_m };
}
