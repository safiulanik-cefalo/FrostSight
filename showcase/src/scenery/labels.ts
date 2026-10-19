// Which place names fit on screen: labels are tried in the bake's priority order and one that would overlap
// an earlier label (or a reserved box, such as the station's tag) is hidden. Pure, so it can be tested.
import type { Place, PlaceKind } from "./assets";

export type ScreenBox = { x: number; y: number; w: number; h: number };

/** Approximate pixels per character, from the lettering in places.css. */
const CHAR_PX: Partial<Record<PlaceKind, number>> = { town: 11.5, island: 9 };
const LABEL_H = 16;
const GAP = 6;

export function labelBox(p: Place, sx: number, sy: number): ScreenBox {
  const w = p.name.length * (CHAR_PX[p.kind] ?? 6.8) + (p.kind === "peak" ? 10 : 0) + GAP;
  return { x: sx - w / 2, y: sy - LABEL_H / 2, w, h: LABEL_H };
}

export function overlaps(a: ScreenBox, b: ScreenBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Tier shown at a camera distance in scene units: towns and islands from afar, rivers and capes close up. */
export function tierFor(distance: number): 1 | 2 | 3 {
  return distance > 300 ? 1 : distance > 170 ? 2 : 3;
}

/**
 * Indices of the labels to show. `screen[i]` is label i's projected position, or null when it is behind the
 * camera or off screen. Labels above `maxTier` are skipped, the rest placed greedily in order.
 */
export function fitLabels(places: Place[], screen: Array<[number, number] | null>, maxTier: number, reserved: ScreenBox[] = []): number[] {
  const taken = [...reserved];
  const out: number[] = [];
  places.forEach((p, i) => {
    const at = screen[i];
    if (!at || p.tier > maxTier) return;
    const box = labelBox(p, at[0], at[1]);
    if (taken.some((t) => overlaps(box, t))) return;
    taken.push(box);
    out.push(i);
  });
  return out;
}
