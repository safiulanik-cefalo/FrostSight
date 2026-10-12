// Ambience cars: never traffic data. Fewer and slower as the risk rises, never inside a closed stretch.
import type { LevelOrNone } from "../../shared/contract";

const PLAN: Record<LevelOrNone, { count: number; speed_mps: number }> = {
  LOW: { count: 4, speed_mps: 22 },
  MEDIUM: { count: 4, speed_mps: 18 },
  HIGH: { count: 3, speed_mps: 13 },
  VERY_HIGH: { count: 2, speed_mps: 8 },
  NONE: { count: 3, speed_mps: 18 },
};

export function carPlan(level: LevelOrNone): { count: number; speed_mps: number } {
  return { ...PLAN[level] };
}

export function openRanges(lengthM: number, closures: Array<{ start_m: number; end_m: number }>): Array<[number, number]> {
  const sorted = [...closures].sort((a, b) => a.start_m - b.start_m);
  const out: Array<[number, number]> = [];
  let from = 0;
  for (const c of sorted) {
    if (c.start_m > from) out.push([from, Math.min(c.start_m, lengthM)]);
    from = Math.max(from, c.end_m);
  }
  if (from < lengthM) out.push([from, lengthM]);
  return out;
}

export function advanceCar(posM: number, dir: 1 | -1, speedMps: number, dtS: number, range: [number, number]): number {
  const [lo, hi] = range;
  const span = hi - lo;
  if (span <= 0) return lo;
  const next = posM + dir * speedMps * dtS - lo;
  return lo + (((next % span) + span) % span);
}
