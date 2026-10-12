// Rows for the list panel and the detail panel, filtered to the site's road on a site.
import type { LevelOrNone, State } from "../../shared/contract";
import { isClosureIncident, isSimulatedIncident } from "../scene/dressing";

export type SegmentRow = { id: string; title: string; subtitle: string; level: LevelOrNone; score: number | null; closed: boolean; stationId: string | null };
export type StationRow = { id: string; title: string; subtitle: string; level: LevelOrNone; score: number | null; reporting: boolean };
export type IncidentRow = { id: string; title: string; subtitle: string; active: boolean; closure: boolean; simulated: boolean; segmentId: string | null; start: string };

/** null on the overview; on a site, the station's road, else the baked road, else "" which matches nothing. */
const siteRoad = (state: State, siteId: string | null, fallback?: string) =>
  siteId ? state.stations.find((s) => s.station_id === siteId)?.road ?? fallback ?? "" : null;

const isActive = (end: string | null, now: Date) => end === null || new Date(end).getTime() > now.getTime();

export function segmentRows(state: State, siteId: string | null, now: Date, fallbackRoad?: string): SegmentRow[] {
  const road = siteRoad(state, siteId, fallbackRoad);
  const closedIds = new Set(
    state.incidents.filter((i) => isClosureIncident(i.incident_type) && isActive(i.end_time, now)).map((i) => i.road_segment_id),
  );
  return state.segments
    .filter((s) => road === null || s.road === road)
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

export function stationRows(state: State, siteId: string | null, fallbackRoad?: string): StationRow[] {
  const road = siteRoad(state, siteId, fallbackRoad);
  const rows = state.stations
    .filter((s) => road === null || s.road === road)
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

const TYPE_LABEL: Record<string, string> = { roadClosed: "Road closed", accident: "Accident", roadworks: "Roadworks" };
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

export function incidentRows(state: State, siteId: string | null, now: Date, fallbackRoad?: string): IncidentRow[] {
  const road = siteRoad(state, siteId, fallbackRoad);
  return state.incidents
    .filter((i) => road === null || i.road === road)
    .map((i) => ({
      id: i.incident_id,
      title: typeLabel(i.incident_type),
      subtitle: i.description ?? i.road,
      active: isActive(i.end_time, now),
      closure: isClosureIncident(i.incident_type),
      simulated: isSimulatedIncident(i.incident_id),
      segmentId: i.road_segment_id,
      start: i.start_time,
    }));
}

export function driverChip(contribution: number): "Driver" | "Rising" | "Minor" {
  if (contribution >= 0.25) return "Driver";
  if (contribution >= 0.1) return "Rising";
  return "Minor";
}
