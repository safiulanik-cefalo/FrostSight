import { describe, it, expect, beforeEach } from "vitest";
import { useShowcase, currentState } from "./store";
import { baseState } from "./fixtures";
import type { Scenario } from "./scenario";

const storm: Scenario = {
  id: "s", title: "Storm", blurb: "", duration_s: 60,
  steps: [{ at_s: 30, patch: { stations: [{ station_id: "3000014", risk_level: "VERY_HIGH" }] } }],
};

beforeEach(() => useShowcase.setState({ live: baseState(), via: "live", scenario: null, clockS: 0, playing: false }));

describe("store", () => {
  it("returns the live state when no scenario is on", () => {
    expect(currentState(useShowcase.getState())?.source).toBe("live");
  });

  it("plays a scenario and stops at its end", () => {
    useShowcase.getState().setScenario(storm);
    expect(useShowcase.getState().playing).toBe(true);
    useShowcase.getState().tick(45);
    expect(currentState(useShowcase.getState())?.stations[0].risk_level).toBe("VERY_HIGH");
    useShowcase.getState().tick(100);
    expect(useShowcase.getState().clockS).toBe(60);
    expect(useShowcase.getState().playing).toBe(false);
  });

  it("does not advance the clock while paused", () => {
    useShowcase.getState().setScenario(storm);
    useShowcase.getState().togglePlay();
    useShowcase.getState().tick(10);
    expect(useShowcase.getState().clockS).toBe(0);
  });

  it("moves between overview and a site and clears the selection", () => {
    useShowcase.getState().goSite("3000014");
    expect(useShowcase.getState()).toMatchObject({ view: "site", siteId: "3000014", segmentId: null });
    useShowcase.getState().goOverview();
    expect(useShowcase.getState()).toMatchObject({ view: "overview", siteId: null });
  });
});

describe("focusIncident", () => {
  const withIncidents = () => {
    const s = baseState();
    s.incidents = [
      { incident_id: "near", road: "E8", road_segment_id: "x", station_id: "3000014", station_km: 0.8, lat: 69.13, lon: 20.76, incident_type: "roadworks", severity: null, start_time: "2026-10-12T05:00:00Z", end_time: null, description: null },
      { incident_id: "far", road: "E10", road_segment_id: null, station_id: null, station_km: null, lat: 68.6, lon: 16.5, incident_type: "roadworks", severity: null, start_time: "2026-10-12T05:00:00Z", end_time: null, description: null },
      { incident_id: "sim-1", road: "E8", road_segment_id: "1125788-27-9", incident_type: "roadClosed", severity: null, start_time: "2026-10-12T05:00:00Z", end_time: null, description: null },
    ];
    return s;
  };
  beforeEach(() => useShowcase.setState({ live: withIncidents(), view: "overview", siteId: null, segmentId: null, incidentId: null }));

  it("opens the nearest station's site and selects its segment", () => {
    useShowcase.getState().focusIncident("near");
    expect(useShowcase.getState()).toMatchObject({ view: "site", siteId: "3000014", segmentId: "1125788-27-9", incidentId: "near" });
  });
  it("marks an incident far from any station on the overview", () => {
    useShowcase.getState().goSite("3000014");
    useShowcase.getState().focusIncident("far");
    expect(useShowcase.getState()).toMatchObject({ view: "overview", siteId: null, incidentId: "far" });
  });
  it("goes to the site of the segment for an incident without a position", () => {
    useShowcase.getState().focusIncident("sim-1");
    expect(useShowcase.getState()).toMatchObject({ view: "site", siteId: "3000014", segmentId: "1125788-27-9", incidentId: "sim-1" });
  });
  it("clears the marked incident when the viewer moves on", () => {
    useShowcase.getState().focusIncident("near");
    useShowcase.getState().goOverview();
    expect(useShowcase.getState().incidentId).toBeNull();
  });
});
