import { useEffect, useMemo, useState } from "react";
import { loadOverviewAssets, type OverviewAssets } from "../data/assets";
import { useCurrentState } from "../data/store";
import type { Level } from "../../shared/contract";

export type SiteRow = { station_id: string; name: string; road: string; climate: string; level: Level | null; reporting: boolean };

const CLIMATE_ORDER = ["coast", "fjord", "inland", "mountain", "warm"];

/** Every baked site with its live level, sorted by climate zone and then name. */
export function useSites(): SiteRow[] {
  const [stations, setStations] = useState<OverviewAssets["stations"]>([]);
  const state = useCurrentState();
  useEffect(() => {
    loadOverviewAssets().then((a) => setStations(a.stations));
  }, []);
  return useMemo(() => {
    const rows = stations.map((s) => {
      const live = state?.stations.find((x) => x.station_id === s.station_id);
      return { station_id: s.station_id, name: s.name, road: s.road, climate: s.climate, level: live?.risk_level ?? null, reporting: live?.status === "Reporting" };
    });
    return rows.sort((a, b) => CLIMATE_ORDER.indexOf(a.climate) - CLIMATE_ORDER.indexOf(b.climate) || a.name.localeCompare(b.name));
  }, [stations, state]);
}
