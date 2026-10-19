// App state: the live document, an optional scenario on a clock, and what the viewer is looking at.
import { useMemo } from "react";
import { create } from "zustand";
import type { State } from "../../shared/contract";
import { loadState } from "./live";
import { DEFAULT_REGION, loadRegions, regionOfCounty, regionOfStation, type Region } from "./regions";
import { stateAt, type Scenario } from "./scenario";
import type { Mode } from "../app/route";
import type { Place } from "../map/places";

/** A station's surroundings at street level. */
const STATION_ZOOM = 12;

export type View = "overview" | "site";
export type Tab = "segments" | "stations" | "incidents";

export type ShowcaseStore = {
  live: State | null;
  via: "live" | "snapshot" | null;
  error: string | null;
  scenario: Scenario | null;
  clockS: number;
  playing: boolean;
  /** the 2D map (default) or the 3D scene */
  mode: Mode;
  /** where the map should pan to; a new object each time so picking the same station again pans again */
  mapFocus: { lat: number; lon: number; zoom: number } | null;
  view: View;
  /** overview regions from the bake, and the one on screen (a site's region while on a site) */
  regions: Region[];
  regionId: string;
  siteId: string | null;
  segmentId: string | null;
  /** the incident marked on the map after a click in the list */
  incidentId: string | null;
  tab: Tab;
  query: string;
  boot(): Promise<void>;
  setScenario(s: Scenario | null): void;
  tick(dtS: number): void;
  seek(tS: number): void;
  togglePlay(): void;
  setMode(mode: Mode): void;
  focusStation(stationId: string): void;
  focusPlace(place: Place): void;
  goOverview(regionId?: string): void;
  goSite(stationId: string): void;
  select(segmentId: string | null): void;
  focusIncident(incidentId: string): void;
  setTab(tab: Tab): void;
  setQuery(q: string): void;
};

const POLL_MS = 60_000;
let polling: ReturnType<typeof setInterval> | null = null;

export const useShowcase = create<ShowcaseStore>((set, get) => ({
  live: null,
  via: null,
  error: null,
  scenario: null,
  clockS: 0,
  playing: false,
  mode: "map",
  mapFocus: null,
  view: "overview",
  regions: [],
  regionId: DEFAULT_REGION,
  siteId: null,
  segmentId: null,
  incidentId: null,
  tab: "segments",
  query: "",

  async boot() {
    const load = async () => {
      try {
        const { state, via } = await loadState();
        set({ live: state, via, error: null });
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    };
    const [regions] = await Promise.all([loadRegions(), load()]);
    set({ regions });
    polling ??= setInterval(load, POLL_MS);
  },
  setScenario(scenario) {
    set({ scenario, clockS: 0, playing: scenario !== null });
  },
  tick(dtS) {
    const { scenario, playing, clockS } = get();
    if (!scenario || !playing) return;
    const next = Math.min(clockS + dtS, scenario.duration_s);
    set({ clockS: next, playing: next < scenario.duration_s });
  },
  seek(tS) {
    const { scenario } = get();
    if (scenario) set({ clockS: Math.max(0, Math.min(tS, scenario.duration_s)) });
  },
  togglePlay() {
    const { scenario, playing, clockS } = get();
    if (!scenario) return;
    set({ playing: !playing, clockS: !playing && clockS >= scenario.duration_s ? 0 : clockS });
  },
  setMode(mode) {
    // scenarios play in the 3D scene only
    set(mode === "map" ? { mode, scenario: null, clockS: 0, playing: false } : { mode });
  },
  focusStation(stationId) {
    const st = get().live?.stations.find((s) => s.station_id === stationId);
    if (st) set({ mapFocus: { lat: st.lat, lon: st.lon, zoom: STATION_ZOOM } });
  },
  focusPlace(place) {
    set({ mapFocus: { lat: place.lat, lon: place.lon, zoom: place.zoom } });
  },
  goOverview(regionId) {
    set({ view: "overview", regionId: regionId ?? get().regionId, siteId: null, segmentId: null, incidentId: null, error: null });
  },
  goSite(stationId) {
    const regionId = regionOfStation(get().regions, stationId)?.id ?? get().regionId;
    set({ view: "site", siteId: stationId, regionId, segmentId: null, incidentId: null, error: null });
  },
  select(segmentId) {
    set({ segmentId });
  },
  focusIncident(incidentId) {
    const state = currentState(get());
    const incident = state?.incidents.find((i) => i.incident_id === incidentId);
    if (!state || !incident) return;
    // the nearest monitored station within coverage; a scenario incident has only its segment
    const stationId =
      incident.station_id ??
      (incident.lat == null ? state.segments.find((s) => s.road_segment_id === incident.road_segment_id)?.station_id : null) ??
      null;
    const { regions, regionId } = get();
    if (stationId) {
      const segmentId = state.segments.find((s) => s.station_id === stationId)?.road_segment_id ?? null;
      const region = regionOfStation(regions, stationId)?.id ?? regionId;
      set({ view: "site", siteId: stationId, regionId: region, segmentId, incidentId, error: null });
    } else {
      const region = regionOfCounty(regions, incident.county)?.id ?? regionId;
      set({ view: "overview", regionId: region, siteId: null, segmentId: null, incidentId, error: null });
    }
  },
  setTab(tab) {
    set({ tab });
  },
  setQuery(query) {
    set({ query });
  },
}));

export function currentState(s: Pick<ShowcaseStore, "live" | "scenario" | "clockS">): State | null {
  if (!s.live) return null;
  return s.scenario ? stateAt(s.scenario, s.live, s.clockS) : s.live;
}

/** The state on screen: live, or the scenario's state at the current clock. Recomputed only when those change. */
export function useCurrentState(): State | null {
  const live = useShowcase((s) => s.live);
  const scenario = useShowcase((s) => s.scenario);
  // whole seconds are enough for the HUD and keep React from re-rendering every frame
  const clockS = useShowcase((s) => Math.floor(s.clockS));
  return useMemo(() => currentState({ live, scenario, clockS }), [live, scenario, clockS]);
}
