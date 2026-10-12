// Deterministic scenery per station: trees below the treeline, fewer in mountain and inland climates,
// none on the road. Live incident types that mean the road is closed.
export const TREELINE_M: Record<string, number> = { coast: 450, fjord: 500, inland: 550, mountain: 650, warm: 600 };
const DENSITY: Record<string, number> = { coast: 1, fjord: 1, inland: 0.7, mountain: 0.4, warm: 1 };
const ROAD_CLEARANCE = 7;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** mulberry32 */
export function rng(seed: string): () => number {
  let a = hashString(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function treePlacements(
  seed: string,
  climate: string,
  heightM: (x: number, z: number) => number,
  distToRoad: (x: number, z: number) => number,
  size: number,
  count: number,
): Array<{ x: number; z: number; s: number }> {
  const rand = rng(`${seed}:trees`);
  const treeline = TREELINE_M[climate] ?? 550;
  const want = Math.round(count * (DENSITY[climate] ?? 0.7));
  const out: Array<{ x: number; z: number; s: number }> = [];
  for (let tries = 0; out.length < want && tries < want * 40; tries++) {
    const x = (rand() - 0.5) * size;
    const z = (rand() - 0.5) * size;
    const jitter = rand();
    const h = heightM(x, z);
    if (h <= 1 || h >= treeline || distToRoad(x, z) < ROAD_CLEARANCE) continue;
    out.push({ x, z, s: (0.85 + jitter * 0.3) * (1.1 - (0.7 * h) / treeline) });
  }
  return out;
}

export function isClosureIncident(incidentType: string): boolean {
  return /clos(ed|ure)/i.test(incidentType);
}

/** Scenario incidents carry ids starting "sim-" (written by tools/make_scenarios.py). */
export function isSimulatedIncident(incidentId: string): boolean {
  return incidentId.startsWith("sim-");
}

/** A scenario closure has a known stretch; a live one is placed near the station because DATEX positions are not in the state. */
export function closureLabel(c: { start_m: number; end_m: number; simulated: boolean }, stationName: string): string {
  if (!c.simulated) return `Road closed near ${stationName} · position approximate`;
  return `Road closed · km ${(c.start_m / 1000).toFixed(0)} to ${(c.end_m / 1000).toFixed(0)}`;
}
