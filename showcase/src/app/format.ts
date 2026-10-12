// Words and numbers for the HUD, kept pure so they can be tested.
import { ageLabel, dataAgeMinutes, levelLabel, type State } from "../../shared/contract";

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/ø/gi, "o").replace(/æ/gi, "ae").toLowerCase();

export function filterSites<T extends { name: string; road: string }>(sites: T[], query: string): T[] {
  const q = fold(query.trim());
  if (!q) return sites;
  return sites.filter((s) => fold(s.name).includes(q) || fold(s.road).includes(q));
}

export function siteSummary(state: State, stationId: string): string {
  const seg = state.segments.find((s) => s.station_id === stationId);
  return seg ? `${levelLabel(seg.risk_level)} · icing ${seg.icing_score.toFixed(2)}` : "No current risk";
}

export function kpiNarrow(state: State, stationId: string, fallbackRoad = ""): { road: string; high: number; total: number } {
  const road = state.stations.find((s) => s.station_id === stationId)?.road ?? fallbackRoad;
  const onRoad = state.segments.filter((s) => s.road === road);
  return { road, high: onRoad.filter((s) => s.risk_level === "HIGH" || s.risk_level === "VERY_HIGH").length, total: onRoad.length };
}

export type ChipTone = "live" | "snapshot" | "simulated";

export function liveChip(state: State, via: "live" | "snapshot" | null, now: Date): { tone: ChipTone; text: string } {
  if (state.source === "scenario" && state.scenario) return { tone: "simulated", text: `Simulated · ${state.scenario.title}` };
  const at = state.gold.risk_updated_at ?? state.generated_at;
  const age = ageLabel(dataAgeMinutes(at, now));
  return via === "snapshot" || state.source === "snapshot"
    ? { tone: "snapshot", text: `Snapshot · ${age}` }
    : { tone: "live", text: `Live · ${age}` };
}
