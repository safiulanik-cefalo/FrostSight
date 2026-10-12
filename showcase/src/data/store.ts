// App state: the live document, an optional scenario on a clock, and what the viewer is looking at.
import { useMemo } from "react";
import { create } from "zustand";
import type { State } from "../../shared/contract";
import { loadState } from "./live";
import { stateAt, type Scenario } from "./scenario";

export type View = "overview" | "site";
export type Tab = "segments" | "stations" | "incidents";

export type ShowcaseStore = {
  live: State | null;
  via: "live" | "snapshot" | null;
  error: string | null;
  scenario: Scenario | null;
  clockS: number;
  playing: boolean;
  view: View;
  siteId: string | null;
  segmentId: string | null;
  tab: Tab;
  query: string;
  boot(): Promise<void>;
  setScenario(s: Scenario | null): void;
  tick(dtS: number): void;
  seek(tS: number): void;
  togglePlay(): void;
  goOverview(): void;
  goSite(stationId: string): void;
  select(segmentId: string | null): void;
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
  view: "overview",
  siteId: null,
  segmentId: null,
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
    await load();
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
  goOverview() {
    set({ view: "overview", siteId: null, segmentId: null });
  },
  goSite(stationId) {
    set({ view: "site", siteId: stationId, segmentId: null });
  },
  select(segmentId) {
    set({ segmentId });
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
