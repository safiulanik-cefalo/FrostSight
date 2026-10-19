// Where each landmark's toy model stands: under its label, on the ground, turned a fixed way per landmark.
import type { LandmarkModel, Place } from "./assets";

export type PlacedLandmark = { key: string; model: LandmarkModel; x: number; y: number; z: number; yaw: number };

/** A fixed turn per name, so a church faces the same way on every visit. */
function yawOf(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 360) * (Math.PI / 180);
}

/** The places the bake gave a model (by Kartverket type), on the plate, in scene units. */
export function placeLandmarks(
  places: Place[],
  site: { upm: number; ground: (x: number, z: number) => number },
  half: number,
): PlacedLandmark[] {
  return places.flatMap((p) => {
    if (!p.model) return [];
    const x = p.xz[0] * site.upm;
    const z = p.xz[1] * site.upm;
    if (Math.abs(x) > half || Math.abs(z) > half) return [];
    // sunk a little so a slope never shows a gap under the walls
    return [{ key: p.name, model: p.model, x, y: site.ground(x, z) - 0.1, z, yaw: yawOf(p.name) }];
  });
}
