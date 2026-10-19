import { describe, it, expect } from "vitest";
import { baseState } from "../data/fixtures";
import { openIncidents, riskDots, stationMarkers } from "./layers";
import type { Incident } from "../../shared/contract";

const now = new Date("2026-10-12T09:30:00Z");

const incident = (patch: Partial<Incident>): Incident => ({
  incident_id: "NPRA_HBT_123_1", road: "E8", county: "Troms", road_segment_id: "1125788-27-9", lat: 69.1265, lon: 20.76,
  incident_type: "roadClosed", severity: "high", start_time: "2026-10-12T08:00:00Z", end_time: null,
  description: "E8 closed at Gardeborri", ...patch,
});

describe("riskDots", () => {
  it("draws each coloured map point with its road, place and score", () => {
    const state = { ...baseState(), map_points: [{ road: "E8", lat: 69.11, lon: 20.73, risk_level: "HIGH" as const, place: "Bossovarri", icing_score: 0.72 }] };
    expect(riskDots(state)).toEqual([{ lat: 69.11, lon: 20.73, level: "HIGH", title: "E8 near Bossovarri", detail: "Icing score 0.72" }]);
  });

  it("is empty for a document from before the 2D map", () => {
    expect(riskDots(baseState())).toEqual([]);
  });
});

describe("stationMarkers", () => {
  it("gives a reporting station its level, surface temperature and reading age", () => {
    expect(stationMarkers(baseState(), now)[0]).toEqual({
      id: "3000014", lat: 69.1202, lon: 20.74511, title: "Bossovarri · E8", level: "HIGH", reporting: true,
      detail: "Surface -3.1 °C · last reading 10 min old",
    });
  });

  it("shows a stale station without a level", () => {
    const stale = stationMarkers(baseState(), now)[1];
    expect(stale.level).toBeNull();
    expect(stale.reporting).toBe(false);
    expect(stale.detail).toBe("Not reporting · last reading 5 h old");
  });
});

describe("openIncidents", () => {
  it("keeps live incidents that have a position and have not ended", () => {
    const state = {
      ...baseState(),
      incidents: [
        incident({}),
        incident({ incident_id: "ended", end_time: "2026-10-12T09:00:00Z" }),
        incident({ incident_id: "no-position", lat: null, lon: null }),
        incident({ incident_id: "sim-closure" }),
        incident({ incident_id: "ends-later", end_time: "2026-10-12T12:00:00Z" }),
      ],
    };
    expect(openIncidents(state, now).map((i) => i.id)).toEqual(["NPRA_HBT_123_1", "ends-later"]);
    expect(openIncidents(state, now)[0]).toEqual({ id: "NPRA_HBT_123_1", lat: 69.1265, lon: 20.76, title: "Road closed · E8", detail: "E8 closed at Gardeborri" });
  });
});
