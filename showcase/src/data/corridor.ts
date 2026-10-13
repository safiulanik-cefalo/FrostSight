// The road corridor of a site: 2 km stretches coloured by the station's risk within its coverage, and
// positions along the resampled road. Same coverage rule as gold.map_points (5 km along the road).
import type { Level, LevelOrNone } from "../../shared/contract";

export const STRETCH_M = 2000;
export const COVERAGE_M = 5000;
export const STEP_M = 25;

export type Stretch = { start_m: number; end_m: number; level: LevelOrNone; closed: boolean; simulated: boolean };
export type Closure = { start_m: number; end_m: number; simulated: boolean; approximate?: boolean };

export function stretches(
  lengthM: number,
  stationAtM: number,
  level: Level | null,
  closures: Closure[],
  stretchM = STRETCH_M,
  coverageM = COVERAGE_M,
): Stretch[] {
  const out: Stretch[] = [];
  for (let start = 0; start < lengthM; start += stretchM) {
    const end = Math.min(lengthM, start + stretchM);
    const mid = (start + end) / 2;
    const hit = closures.find((c) => start < c.end_m && end > c.start_m);
    out.push({
      start_m: start,
      end_m: end,
      level: level && Math.abs(mid - stationAtM) <= coverageM ? level : "NONE",
      closed: Boolean(hit),
      simulated: hit?.simulated ?? false,
    });
  }
  return out;
}

export function pointAt(points: [number, number][], atM: number, stepM = STEP_M): { x: number; z: number; tx: number; tz: number } {
  const last = points.length - 1;
  const i = Math.max(0, Math.min(last - 1, Math.floor(atM / stepM)));
  const [x0, z0] = points[i];
  const [x1, z1] = points[i + 1];
  const segLen = Math.hypot(x1 - x0, z1 - z0) || 1;
  const t = Math.max(0, Math.min(1, (atM - i * stepM) / segLen));
  return { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, tx: (x1 - x0) / segLen, tz: (z1 - z0) / segLen };
}
