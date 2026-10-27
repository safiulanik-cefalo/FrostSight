// Rows for the list panel and the detail panel, filtered to the site's road on a site.
import type { LevelOrNone, State } from "../../shared/contract";
import { COVERAGE_M } from "../data/corridor";
import { inRegion, type Region } from "../data/regions";
import { isClosureIncident, isSimulatedIncident } from "../scene/dressing";

export type SegmentRow = { id: string; title: string; subtitle: string; level: LevelOrNone; score: number | null; closed: boolean; stationId: string | null };
export type StationRow = { id: string; title: string; subtitle: string; level: LevelOrNone; score: number | null; reporting: boolean };
export type IncidentRow = {
  id: string; title: string; subtitle: string; active: boolean; closure: boolean; simulated: boolean; segmentId: string | null; start: string;
  /** the monitored station within coverage on the incident's road, where a click goes; null when none is */
  stationId: string | null;
  /** has its own position, so it can be marked on the map */
  located: boolean;
  where: string | null;
};

/** null on the overview; on a site, the station's road, else the baked road, else "" which matches nothing. */
const siteRoad = (state: State, siteId: string | null, fallback?: string) =>
  siteId ? state.stations.find((s) => s.station_id === siteId)?.road ?? fallback ?? "" : null;

const isActive = (end: string | null, now: Date) => end === null || new Date(end).getTime() > now.getTime();

/** On a site: rows on the site's road. On an overview: rows in the region's counties (all when region is null). */
const keep = (road: string | null, region: Region | null | undefined, row: { road: string; county?: string | null }) =>
  road === null ? inRegion(region, row.county) : row.road === road;

export function segmentRows(state: State, siteId: string | null, now: Date, fallbackRoad?: string, region?: Region | null): SegmentRow[] {
  const road = siteRoad(state, siteId, fallbackRoad);
  const closedIds = new Set(
    state.incidents.filter((i) => isClosureIncident(i.incident_type) && isActive(i.end_time, now)).map((i) => i.road_segment_id),
  );
  return state.segments
    .filter((s) => keep(road, region, s))
    .sort((a, b) => b.icing_score - a.icing_score)
    .map((s) => ({
      id: s.road_segment_id,
      title: state.stations.find((x) => x.station_id === s.station_id)?.name ?? s.segment,
      subtitle: s.priority_rank ? `${s.road} · priority ${s.priority_rank}` : s.road,
      level: s.risk_level,
      score: s.icing_score,
      closed: closedIds.has(s.road_segment_id),
      stationId: s.station_id,
    }));
}

export function stationRows(state: State, siteId: string | null, fallbackRoad?: string, region?: Region | null): StationRow[] {
  const road = siteRoad(state, siteId, fallbackRoad);
  const rows = state.stations
    .filter((s) => keep(road, region, s))
    .map((s) => ({
      id: s.station_id,
      title: s.name,
      subtitle: `${s.road} · ${s.status === "Reporting" ? "reporting" : "stale"}`,
      level: (s.risk_level ?? "NONE") as LevelOrNone,
      score: s.icing_score,
      reporting: s.status === "Reporting",
    }));
  return [...rows.filter((r) => r.reporting), ...rows.filter((r) => !r.reporting)];
}

// DATEX II record types as the NPRA feed sends them, and the scenario's camelCase ones
const TYPE_LABEL: Record<string, string> = {
  roadClosed: "Road closed",
  accident: "Accident",
  roadworks: "Roadworks",
  MAINTENANCEWORKS: "Roadworks",
  ROADORCARRIAGEWAYORLANEMANAGEMENT: "Lane or road restriction",
  REROUTINGMANAGEMENT: "Diversion",
  GENERALNETWORKMANAGEMENT: "Traffic management",
  SPEEDMANAGEMENT: "Speed restriction",
};
/**
 * The DATEX II feed packs multiple clauses into one string: "|" separates top-level clauses, and a run of
 * "Periode N: ..." clauses has no separator between them at all. Break both apart into one clause per line,
 * so the UI doesn't show one unreadable run-on sentence. Doesn't translate the Norwegian text itself.
 */
export function formatIncidentDescription(description: string | null): string {
  if (!description) return "";
  return description
    .split("|")
    .flatMap((clause) => clause.split(/(?=Periode\s*\d+\s*:)/i))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function incidentLabel(t: string): string {
  if (TYPE_LABEL[t]) return TYPE_LABEL[t];
  const words = t === t.toUpperCase() ? t.toLowerCase() : t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.replace(/^./, (c) => c.toUpperCase());
}

export function incidentRows(state: State, siteId: string | null, now: Date, fallbackRoad?: string, region?: Region | null): IncidentRow[] {
  const road = siteRoad(state, siteId, fallbackRoad);
  return state.incidents
    .filter((i) => keep(road, region, i))
    .map((i) => ({
      id: i.incident_id,
      title: incidentLabel(i.incident_type),
      subtitle: i.description ? formatIncidentDescription(i.description) : i.road,
      active: isActive(i.end_time, now),
      closure: isClosureIncident(i.incident_type),
      simulated: isSimulatedIncident(i.incident_id),
      segmentId: i.road_segment_id,
      start: i.start_time,
      stationId: i.station_id ?? null,
      located: i.lat != null && i.lon != null,
      where: incidentWhere(state, i),
    }))
    .sort((x, y) => Number(y.active) - Number(x.active) || Number(!!y.stationId) - Number(!!x.stationId) || y.start.localeCompare(x.start));
}

function incidentWhere(state: State, i: State["incidents"][number]): string | null {
  const name = i.station_id ? state.stations.find((s) => s.station_id === i.station_id)?.name : undefined;
  if (name && i.station_km != null) return `${i.station_km} km from ${name}`;
  if (i.lat != null && i.lon != null) return `No station within ${COVERAGE_M / 1000} km`;
  return null;
}

export function driverChip(contribution: number): "Driver" | "Rising" | "Minor" {
  if (contribution >= 0.25) return "Driver";
  if (contribution >= 0.1) return "Rising";
  return "Minor";
}
