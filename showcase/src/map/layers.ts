// What the 2D map draws, from the state document: coloured road points, stations and open live incidents.
// Pure, so the Leaflet view only places markers and popups.
import { ageLabel, dataAgeMinutes, type Level, type State } from "../../shared/contract";
import { incidentLabel } from "../app/listRows";
import { isSimulatedIncident } from "../scene/dressing";

export type MapDot = { lat: number; lon: number; level: Level; title: string; detail: string };
export type StationMarker = { id: string; lat: number; lon: number; title: string; level: Level | null; reporting: boolean; detail: string };
export type IncidentMarker = { id: string; lat: number; lon: number; title: string; detail: string };

/** gold.map_points as the AI/BI risk map draws them; none in a document from before the 2D map. */
export function riskDots(state: State): MapDot[] {
  return (state.map_points ?? []).map((p) => ({
    lat: p.lat,
    lon: p.lon,
    level: p.risk_level,
    title: p.place ? `${p.road} near ${p.place}` : p.road,
    detail: p.icing_score === null ? "" : `Icing score ${p.icing_score.toFixed(2)}`,
  }));
}

export function stationMarkers(state: State, now: Date): StationMarker[] {
  return state.stations.map((s) => {
    const reporting = s.status === "Reporting";
    const surface = state.segments.find((g) => g.station_id === s.station_id)?.surface_c ?? null;
    const age = s.last_event_time ? `last reading ${ageLabel(dataAgeMinutes(s.last_event_time, now))}` : "no reading yet";
    const lead = reporting ? (surface === null ? null : `Surface ${surface.toFixed(1)} °C`) : "Not reporting";
    return {
      id: s.station_id,
      lat: s.lat,
      lon: s.lon,
      title: `${s.name} · ${s.road}`,
      level: reporting ? s.risk_level : null,
      reporting,
      detail: lead ? `${lead} · ${age}` : age.replace(/^./, (c) => c.toUpperCase()),
    };
  });
}

/** Live incidents with their own position that have not ended; scenario incidents stay in the 3D view. */
export function openIncidents(state: State, now: Date): IncidentMarker[] {
  return state.incidents
    .filter((i) => i.lat != null && i.lon != null && !isSimulatedIncident(i.incident_id))
    .filter((i) => !i.end_time || new Date(i.end_time).getTime() > now.getTime())
    .map((i) => ({ id: i.incident_id, lat: i.lat!, lon: i.lon!, title: `${incidentLabel(i.incident_type)} · ${i.road}`, detail: i.description ?? "" }));
}
