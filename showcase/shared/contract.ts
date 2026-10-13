// The one state document the Worker builds from the plot-ready gold tables and the app renders.
// Field names follow the gold tables (spec section 6) so a number on screen traces back to a column.
import { z } from "zod";

export const LEVELS = ["LOW", "MEDIUM", "HIGH", "VERY_HIGH"] as const;
export type Level = (typeof LEVELS)[number];
export type LevelOrNone = Level | "NONE";

export const LEVEL_COLOR: Record<LevelOrNone, string> = {
  LOW: "#2e9e5b",
  MEDIUM: "#c98a12",
  HIGH: "#e0532f",
  VERY_HIGH: "#8e2f9c",
  NONE: "#8a95ab",
};
export const SIMULATED_COLOR = "#5b4bd6";

const LABEL: Record<Level, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", VERY_HIGH: "Very high" };

export function levelLabel(level: Level | null): string {
  return level ? LABEL[level] : "No data";
}

const level = z.enum(LEVELS);
const iso = z.string();
const num = z.number();

// county: the DATEX county name (Troms, Oslo, Akershus, Innlandet); documents from before the column are Troms
const county = z.string().nullable().optional();

const StationSchema = z.object({
  station_id: z.string(),
  name: z.string(),
  road: z.string(),
  county,
  lat: num,
  lon: num,
  road_segment_id: z.string().nullable(),
  status: z.enum(["Reporting", "Stale"]),
  last_event_time: iso.nullable(),
  risk_level: level.nullable(),
  icing_score: num.nullable(),
});

const SegmentSchema = z.object({
  road_segment_id: z.string(),
  segment: z.string(),
  road: z.string(),
  county,
  station_id: z.string().nullable(),
  risk_level: level,
  icing_score: num,
  surface_c: num.nullable(),
  air_c: num.nullable(),
  change_1h_c: num.nullable(),
  event_time: iso.nullable(),
  priority_rank: num.nullable(),
  drivers: z.array(z.object({ factor: z.string(), contribution: num })),
  readings: z.object({
    dew_point_c: num.nullable(),
    precip_type: z.string().nullable(),
    precip_mm_h: num.nullable(),
    wind_ms: num.nullable(),
  }),
});

// Live incidents come from gold.incident_list with their own position and the nearest monitored station on
// their road within coverage; scenario incidents have neither, so these fields are optional.
const IncidentSchema = z.object({
  incident_id: z.string(),
  situation_id: z.string().nullable().optional(),
  road: z.string(),
  county,
  road_segment_id: z.string().nullable(),
  station_id: z.string().nullable().optional(),
  station_km: num.nullable().optional(),
  lat: num.nullable().optional(),
  lon: num.nullable().optional(),
  incident_type: z.string(),
  severity: z.string().nullable(),
  start_time: iso,
  end_time: iso.nullable(),
  description: z.string().nullable(),
});

const HistoryPointSchema = z.object({ t: iso, level, score: num });

export const StateSchema = z.object({
  generated_at: iso,
  source: z.enum(["live", "snapshot", "scenario"]),
  scenario: z.object({ id: z.string(), title: z.string(), step_s: num }).optional(),
  gold: z.object({ risk_updated_at: iso.nullable(), computed_at: iso.nullable() }),
  kpi: z.object({
    segments_total: num,
    segments_high: num,
    segments_very_high: num,
    stations_total: num,
    stations_reporting: num,
    active_incidents: num,
  }),
  stations: z.array(StationSchema),
  segments: z.array(SegmentSchema),
  incidents: z.array(IncidentSchema),
  history: z.record(z.array(HistoryPointSchema)),
});

export type State = z.infer<typeof StateSchema>;
export type Station = z.infer<typeof StationSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type Incident = z.infer<typeof IncidentSchema>;
export type HistoryPoint = z.infer<typeof HistoryPointSchema>;

export function parseState(json: unknown): State {
  return StateSchema.parse(json);
}

export function dataAgeMinutes(isoTime: string, now: Date): number {
  return (now.getTime() - new Date(isoTime).getTime()) / 60000;
}

export function ageLabel(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${Math.round(minutes)} min old`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h old`;
  return `${Math.round(minutes / 1440)} d old`;
}
