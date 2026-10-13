// Overview regions baked by tools/bake_sites.py (public/overview/index.json): Troms, Oslo and Akershus together,
// and Innlandet. Rows carry the DATEX county; a region groups counties for one overview map.
import type { State } from "../../shared/contract";

export type Region = { id: string; name: string; counties: string[]; stations: string[] };
export type RegionKpi = State["kpi"];

export const DEFAULT_REGION = "troms";

/** Documents written before the county column held Troms only. */
const countyOf = (c: string | null | undefined) => c ?? "Troms";

export function inRegion(region: Region | null | undefined, county: string | null | undefined): boolean {
  return !region || region.counties.includes(countyOf(county));
}

export function regionOfStation(regions: Region[], stationId: string): Region | undefined {
  return regions.find((r) => r.stations.includes(stationId));
}

export function regionOfCounty(regions: Region[], county: string | null | undefined): Region | undefined {
  return regions.find((r) => r.counties.includes(countyOf(county)));
}

/** The counter cards for one region, counted from its rows the same way gold counts kpi_summary. */
export function regionKpi(state: State, region: Region, now: Date): RegionKpi {
  const segments = state.segments.filter((s) => inRegion(region, s.county));
  const stations = state.stations.filter((s) => inRegion(region, s.county));
  const active = state.incidents.filter(
    (i) => inRegion(region, i.county) && new Date(i.start_time) <= now && (!i.end_time || new Date(i.end_time) > now),
  );
  return {
    segments_total: segments.length,
    segments_high: segments.filter((s) => s.risk_level === "HIGH" || s.risk_level === "VERY_HIGH").length,
    segments_very_high: segments.filter((s) => s.risk_level === "VERY_HIGH").length,
    stations_total: stations.length,
    stations_reporting: stations.filter((s) => s.status === "Reporting").length,
    // one situation can be several DATEX records, as in gold's incident_summary
    active_incidents: new Set(active.map((i) => i.situation_id ?? i.incident_id)).size,
  };
}

let regionsPromise: Promise<Region[]> | null = null;

export function loadRegions(fetchFn: typeof fetch = fetch): Promise<Region[]> {
  regionsPromise ??= fetchFn("/overview/index.json")
    .then((r) => (r.ok ? (r.json() as Promise<Region[]>) : []))
    .catch(() => []);
  return regionsPromise;
}
