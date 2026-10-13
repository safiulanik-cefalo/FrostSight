import { useShowcase } from "../data/store";
import type { Region } from "../data/regions";

/** The region on screen: the overview's, or the current site's. */
export function useRegion(): Region | null {
  const regions = useShowcase((s) => s.regions);
  const regionId = useShowcase((s) => s.regionId);
  return regions.find((r) => r.id === regionId) ?? null;
}
