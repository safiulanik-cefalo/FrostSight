// Scripted scenarios: steps of partial states merged over a real snapshot, played on a clock.
import { z } from "zod";
import { LEVELS, type HistoryPoint, type Incident, type Level, type Segment, type State, type Station } from "../../shared/contract";

type SegmentPatch = Partial<Omit<Segment, "readings">> & { road_segment_id: string; readings?: Partial<Segment["readings"]> };
export type Patch = {
  gold?: Partial<State["gold"]>;
  kpi?: Partial<State["kpi"]>;
  stations?: Array<Partial<Station> & { station_id: string }>;
  segments?: SegmentPatch[];
  incidents?: Array<Partial<Incident> & { incident_id: string }>;
  history?: Record<string, HistoryPoint[]>;
};

const level = z.enum(LEVELS);
export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  blurb: z.string(),
  duration_s: z.number().positive(),
  focus_station_id: z.string().optional(),
  history_rel: z.record(z.array(z.object({ ago_h: z.number().nonnegative(), level, score: z.number() }))).optional(),
  closures: z.array(z.object({ at_s: z.number(), station_id: z.string(), start_m: z.number(), end_m: z.number() })).optional(),
  outlook: z.array(z.object({ at_h: z.number(), level, score: z.number() })).optional(),
  steps: z.array(z.object({ at_s: z.number(), patch: z.record(z.unknown()) })),
});
export type Scenario = Omit<z.infer<typeof ScenarioSchema>, "steps"> & { steps: Array<{ at_s: number; patch: Patch }> };
export type ScenarioClosure = { station_id: string; start_m: number; end_m: number };

const ID_KEY: Record<string, string> = { stations: "station_id", segments: "road_segment_id", incidents: "incident_id" };

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

function merge(base: unknown, patch: unknown, key?: string): unknown {
  if (Array.isArray(patch)) {
    const id = key ? ID_KEY[key] : undefined;
    if (!id || !Array.isArray(base)) return structuredClone(patch);
    const out = base.map((b) => structuredClone(b) as Plain);
    for (const p of patch as Plain[]) {
      const i = out.findIndex((b) => b[id] === p[id]);
      if (i === -1) out.push(structuredClone(p));
      else out[i] = merge(out[i], p) as Plain;
    }
    return out;
  }
  if (isPlain(patch) && isPlain(base)) {
    const out: Plain = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      // history lists are replaced wholesale per segment, never merged item by item
      out[k] = key === "history" ? structuredClone(v) : merge(base[k], v, k);
    }
    return out;
  }
  return patch === undefined ? base : structuredClone(patch);
}

export function applyPatch(base: State, patch: Patch): State {
  return merge(structuredClone(base), patch) as State;
}

const HOUR = 3600_000;

export function stateAt(scenario: Scenario, base: State, tS: number, now: Date = new Date()): State {
  const reached = scenario.steps.filter((s) => s.at_s <= tS).sort((a, b) => a.at_s - b.at_s);
  const history: Record<string, HistoryPoint[]> = {};
  for (const [seg, pts] of Object.entries(scenario.history_rel ?? {})) {
    history[seg] = [...pts]
      .sort((a, b) => b.ago_h - a.ago_h)
      .map((p) => ({ t: new Date(now.getTime() - p.ago_h * HOUR).toISOString(), level: p.level, score: p.score }));
  }
  const withHistory = Object.keys(history).length ? applyPatch(base, { history }) : base;
  const state = reached.reduce((acc, s) => applyPatch(acc, s.patch), withHistory);
  // counters follow the simulated rows, so the KPI cards never disagree with the scene
  const kpi = {
    segments_total: state.segments.length,
    segments_high: state.segments.filter((x) => x.risk_level === "HIGH" || x.risk_level === "VERY_HIGH").length,
    segments_very_high: state.segments.filter((x) => x.risk_level === "VERY_HIGH").length,
    stations_total: state.stations.length,
    stations_reporting: state.stations.filter((x) => x.status === "Reporting").length,
    active_incidents: state.incidents.filter((x) => !x.end_time || new Date(x.end_time).getTime() > now.getTime()).length,
  };
  return { ...state, kpi, source: "scenario", scenario: { id: scenario.id, title: scenario.title, step_s: tS } };
}

export function closuresAt(scenario: Scenario, tS: number): ScenarioClosure[] {
  return (scenario.closures ?? [])
    .filter((c) => c.at_s <= tS)
    .map(({ station_id, start_m, end_m }) => ({ station_id, start_m, end_m }));
}

export function parseScenario(json: unknown): Scenario {
  return ScenarioSchema.parse(json) as Scenario;
}

export type { Level };
