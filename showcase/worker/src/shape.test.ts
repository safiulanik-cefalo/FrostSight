import { describe, it, expect } from "vitest";
import { shapeState, type GoldRows } from "./shape";
import { parseState } from "../../shared/contract";
import fixture from "../fixtures/gold_rows.json";

const rows = fixture as unknown as GoldRows;
const state = shapeState(rows, "2026-10-12T09:28:00Z");

describe("shapeState", () => {
  it("builds a document the contract accepts", () => {
    expect(() => parseState(state)).not.toThrow();
    expect(state.source).toBe("live");
    expect(state.generated_at).toBe("2026-10-12T09:28:00Z");
    expect(state.gold.risk_updated_at).toBe("2026-10-12T09:20:00.000Z");
  });

  it("turns numeric strings into numbers", () => {
    expect(state.kpi).toEqual({ segments_total: 1, segments_high: 1, segments_very_high: 0, stations_total: 2, stations_reporting: 1, active_incidents: 1 });
    expect(state.stations[0].lat).toBeCloseTo(69.1202);
  });

  it("joins drivers, priority and the newest reading onto the segment", () => {
    const seg = state.segments.find((s) => s.road_segment_id === "1125788-27-9")!;
    expect(seg.priority_rank).toBe(2);
    expect(seg.drivers).toEqual([{ factor: "Precipitation", contribution: 0.41 }, { factor: "Surface temperature", contribution: 0.31 }]);
    expect(seg.readings).toEqual({ dew_point_c: -3.4, precip_type: "SNOW", precip_mm_h: 2.4, wind_ms: 11 });
  });

  it("keeps a stale station with no current risk and gives it no segment", () => {
    const st = state.stations.find((s) => s.station_id === "3000016")!;
    expect(st.status).toBe("Stale");
    expect(st.risk_level).toBeNull();
    expect(state.segments.some((s) => s.station_id === "3000016")).toBe(false);
  });

  it("keeps each incident once, at its own position, with the station a click goes to", () => {
    expect(state.incidents).toEqual([{ incident_id: "NPRA_HBT_123_1", situation_id: "NPRA_HBT_123", road: "E8", road_segment_id: "1125788-27-9",
      station_id: "3000014", station_km: 0.8, lat: 69.1265, lon: 20.76, incident_type: "roadClosed", severity: "high",
      start_time: "2026-10-12T08:00:00.000Z", end_time: null, description: "E8 closed at Gardeborri, convoy driving" }]);
  });

  it("keys history by road segment, oldest first", () => {
    expect(state.history["1125788-27-9"]).toEqual([
      { t: "2026-10-12T06:00:00.000Z", level: "MEDIUM", score: 0.48 },
      { t: "2026-10-12T09:20:00.000Z", level: "HIGH", score: 0.72 },
    ]);
  });
});
