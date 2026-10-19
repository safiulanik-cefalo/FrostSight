import { describe, it, expect } from "vitest";
import { LEVELS, LEVEL_COLOR, levelLabel, parseState, dataAgeMinutes, ageLabel } from "./contract";

const minimal = {
  generated_at: "2026-10-12T09:28:00Z", source: "live",
  gold: { risk_updated_at: "2026-10-12T09:20:00Z", computed_at: "2026-10-12T09:28:00Z" },
  kpi: { segments_total: 24, segments_high: 3, segments_very_high: 0, stations_total: 24, stations_reporting: 22, active_incidents: 1 },
  stations: [{ station_id: "3000014", name: "Bossovarri", road: "E8", lat: 69.1202, lon: 20.74511, road_segment_id: "1125788-27-9",
               status: "Reporting", last_event_time: "2026-10-12T09:20:00Z", risk_level: "HIGH", icing_score: 0.72 }],
  segments: [{ road_segment_id: "1125788-27-9", segment: "E8 · Bossovarri", road: "E8", station_id: "3000014", risk_level: "HIGH",
               icing_score: 0.72, surface_c: -3.1, air_c: -2.4, change_1h_c: -0.8, event_time: "2026-10-12T09:20:00Z", priority_rank: 2,
               drivers: [{ factor: "Snow", contribution: 0.41 }],
               readings: { dew_point_c: -3.4, precip_type: "SNOW", precip_mm_h: 2.4, wind_ms: 11 } }],
  incidents: [], history: { "1125788-27-9": [{ t: "2026-10-12T06:00:00Z", level: "MEDIUM", score: 0.48 }] },
};

describe("contract", () => {
  it("lists the four levels in order with their colours", () => {
    expect(LEVELS).toEqual(["LOW", "MEDIUM", "HIGH", "VERY_HIGH"]);
    expect(LEVEL_COLOR).toEqual({ LOW: "#2e9e5b", MEDIUM: "#c98a12", HIGH: "#e0532f", VERY_HIGH: "#8e2f9c", NONE: "#8a95ab" });
    expect(levelLabel("VERY_HIGH")).toBe("Very high");
    expect(levelLabel(null)).toBe("No data");
  });
  it("parses a valid state and rejects a bad level", () => {
    expect(parseState(minimal).stations[0].name).toBe("Bossovarri");
    expect(() => parseState({ ...minimal, stations: [{ ...minimal.stations[0], risk_level: "EXTREME" }] })).toThrow();
  });
  it("parses risk map points when present and accepts documents without them", () => {
    const point = { road: "E8", lat: 69.12, lon: 20.74, risk_level: "HIGH", place: "Bossovarri", icing_score: 0.72 };
    expect(parseState({ ...minimal, map_points: [point] }).map_points).toEqual([point]);
    expect(parseState(minimal).map_points).toBeUndefined();
    expect(() => parseState({ ...minimal, map_points: [{ ...point, risk_level: "Road" }] })).toThrow();
  });
  it("describes data age in words", () => {
    const now = new Date("2026-10-12T09:40:00Z");
    expect(dataAgeMinutes("2026-10-12T09:28:00Z", now)).toBe(12);
    expect(ageLabel(0.4)).toBe("just now");
    expect(ageLabel(12)).toBe("12 min old");
    expect(ageLabel(185)).toBe("3 h old");
    expect(ageLabel(60 * 50)).toBe("2 d old");
  });
});
