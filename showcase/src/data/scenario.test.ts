import { describe, it, expect } from "vitest";
import { applyPatch, stateAt, closuresAt, type Scenario } from "./scenario";
import { parseState } from "../../shared/contract";
import { baseState } from "./fixtures";

describe("applyPatch", () => {
  it("merges a station by id and changes only the named fields", () => {
    const out = applyPatch(baseState(), { stations: [{ station_id: "3000016", risk_level: "VERY_HIGH" }] });
    const st = out.stations.find((s) => s.station_id === "3000016")!;
    expect(st.risk_level).toBe("VERY_HIGH");
    expect(st.name).toBe("Gardeborri");
    expect(out.stations).toHaveLength(2);
  });

  it("merges nested readings and appends an unknown segment", () => {
    const extra = { ...baseState().segments[0], road_segment_id: "new-1", station_id: "3000016", segment: "E8 · Gardeborri" };
    const out = applyPatch(baseState(), {
      segments: [{ road_segment_id: "1125788-27-9", readings: { precip_mm_h: 6.5 } }, extra],
    });
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0].readings).toEqual({ dew_point_c: -3.4, precip_type: "SNOW", precip_mm_h: 6.5, wind_ms: 11 });
    expect(out.segments[1].road_segment_id).toBe("new-1");
  });

  it("replaces a history list wholesale and leaves the base untouched", () => {
    const base = baseState();
    const out = applyPatch(base, { history: { "1125788-27-9": [] } });
    expect(out.history["1125788-27-9"]).toEqual([]);
    expect(base.history["1125788-27-9"]).toHaveLength(1);
    expect(out.kpi).toEqual(base.kpi);
  });
});

const scenario: Scenario = {
  id: "t", title: "Test storm", blurb: "", duration_s: 60,
  closures: [{ at_s: 30, station_id: "3000014", start_m: 2000, end_m: 4000 }],
  steps: [
    { at_s: 30, patch: { stations: [{ station_id: "3000014", risk_level: "VERY_HIGH" }] } },
    { at_s: 0, patch: { stations: [{ station_id: "3000014", risk_level: "MEDIUM" }] } },
  ],
};

describe("stateAt", () => {
  it("applies the steps reached so far, in time order, and marks the state simulated", () => {
    expect(stateAt(scenario, baseState(), 10).stations[0].risk_level).toBe("MEDIUM");
    const late = stateAt(scenario, baseState(), 45);
    expect(late.stations[0].risk_level).toBe("VERY_HIGH");
    expect(late.source).toBe("scenario");
    expect(late.scenario).toEqual({ id: "t", title: "Test storm", step_s: 45 });
    expect(() => parseState(late)).not.toThrow();
  });

  it("lists closures that have started", () => {
    expect(closuresAt(scenario, 10)).toEqual([]);
    expect(closuresAt(scenario, 30)).toEqual([{ station_id: "3000014", start_m: 2000, end_m: 4000 }]);
  });
});

describe("relative history", () => {
  it("turns hours-ago points into timestamps before now, oldest first", () => {
    const s: Scenario = {
      ...scenario,
      history_rel: { "1125788-27-9": [{ ago_h: 0, level: "HIGH", score: 0.7 }, { ago_h: 6, level: "LOW", score: 0.2 }] },
    };
    const out = stateAt(s, baseState(), 0, new Date("2026-10-12T12:00:00Z"));
    expect(out.history["1125788-27-9"]).toEqual([
      { t: "2026-10-12T06:00:00.000Z", level: "LOW", score: 0.2 },
      { t: "2026-10-12T12:00:00.000Z", level: "HIGH", score: 0.7 },
    ]);
  });
});

describe("scenario kpis", () => {
  it("recounts the counters from the simulated state", () => {
    const out = stateAt(scenario, baseState(), 45);
    expect(out.kpi).toMatchObject({ segments_total: 1, segments_high: 1, segments_very_high: 0, stations_total: 2, stations_reporting: 1, active_incidents: 0 });
    const withIncident: Scenario = { ...scenario, steps: [...scenario.steps, { at_s: 40, patch: {
      segments: [{ road_segment_id: "1125788-27-9", risk_level: "VERY_HIGH" }],
      incidents: [{ incident_id: "sim-1", road: "E8", road_segment_id: "1125788-27-9", incident_type: "roadClosed", severity: null, start_time: "2026-10-12T09:00:00Z", end_time: null, description: null }],
    } }] };
    expect(stateAt(withIncident, baseState(), 45).kpi).toMatchObject({ segments_very_high: 1, active_incidents: 1 });
  });
});
