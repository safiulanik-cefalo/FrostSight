import { useEffect, useMemo, useState } from "react";
import { loadOverviewAssets, type OverviewAssets } from "../data/assets";
import { useCurrentState, useShowcase } from "../data/store";
import type { Level } from "../../shared/contract";

export type SiteRow = {
  station_id: string;
  name: string;
  road: string;
  climate: string;
  region: string;
  level: Level | null;
  reporting: boolean;
};

/** Every baked site with its live level, region by region in bake order, then by name. */
export function useSites(): SiteRow[] {
  const regions = useShowcase((s) => s.regions);
  const [byRegion, setByRegion] = useState<Record<string, OverviewAssets["stations"]>>({});
  const state = useCurrentState();
  useEffect(() => {
    let live = true;
    Promise.all(regions.map((r) => loadOverviewAssets(r.id).then((a) => [r.id, a.stations] as const)))
      .then((pairs) => live && setByRegion(Object.fromEntries(pairs)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [regions]);
  return useMemo(
    () =>
      regions.flatMap((r) =>
        (byRegion[r.id] ?? [])
          .map((s) => {
            const live = state?.stations.find((x) => x.station_id === s.station_id);
            return {
              station_id: s.station_id,
              name: s.name,
              road: s.road,
              climate: s.climate,
              region: r.id,
              level: live?.risk_level ?? null,
              reporting: live?.status === "Reporting",
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, "nb")),
      ),
    [regions, byRegion, state],
  );
}
