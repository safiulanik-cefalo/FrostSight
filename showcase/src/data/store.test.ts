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

describe("regions in the store", () => {
  const regions = [
    { id: "troms", name: "Troms", counties: ["Troms"], stations: ["3000014", "3000016"] },
    { id: "innlandet", name: "Innlandet", counties: ["Innlandet"], stations: ["500"] },
  ];
  beforeEach(() => useShowcase.setState({ live: baseState(), regions, regionId: "troms", view: "overview", siteId: null, incidentId: null }));

  it("follows a site into its region and keeps it on the way back to the overview", () => {
    useShowcase.getState().goSite("500");
    expect(useShowcase.getState()).toMatchObject({ view: "site", siteId: "500", regionId: "innlandet" });
    useShowcase.getState().goOverview();
    expect(useShowcase.getState()).toMatchObject({ view: "overview", regionId: "innlandet" });
    useShowcase.getState().goOverview("troms");
    expect(useShowcase.getState().regionId).toBe("troms");
  });

  it("shows an incident far from any station on its county's overview", () => {
    const s = baseState();
    s.incidents = [{ incident_id: "far", road: "Rv3", road_segment_id: null, county: "Innlandet", station_id: null, lat: 61.5, lon: 10.9,
      incident_type: "MAINTENANCEWORKS", severity: null, start_time: "2026-10-12T05:00:00Z", end_time: null, description: null }];
    useShowcase.setState({ live: s });
    useShowcase.getState().focusIncident("far");
    expect(useShowcase.getState()).toMatchObject({ view: "overview", regionId: "innlandet", incidentId: "far" });
  });
});

describe("map mode", () => {
  beforeEach(() => useShowcase.setState({ mode: "map", mapFocus: null }));

  it("switches between the map and 3D, and leaves a scenario behind on the map", () => {
    useShowcase.getState().setMode("3d");
    useShowcase.getState().setScenario(storm);
    useShowcase.getState().setMode("map");
    expect(useShowcase.getState().mode).toBe("map");
    expect(useShowcase.getState().scenario).toBeNull();
    expect(useShowcase.getState().playing).toBe(false);
  });

  it("focuses the map on a station, again when picked twice", () => {
    useShowcase.getState().focusStation("3000014");
    const first = useShowcase.getState().mapFocus;
    expect(first).toMatchObject({ lat: 69.1202, lon: 20.74511 });
    useShowcase.getState().focusStation("3000014");
    expect(useShowcase.getState().mapFocus).not.toBe(first);
  });

  it("focuses a station at street zoom and a town at its own zoom", () => {
    useShowcase.getState().focusStation("3000014");
    expect(useShowcase.getState().mapFocus).toMatchObject({ zoom: 12 });
    useShowcase.getState().focusPlace({ name: "Hamar", kind: "Town", municipality: "Hamar", lat: 60.79451, lon: 11.06795, zoom: 11 });
    expect(useShowcase.getState().mapFocus).toEqual({ lat: 60.79451, lon: 11.06795, zoom: 11 });
  });

  it("ignores a station the state does not list", () => {
    useShowcase.getState().focusStation("nope");
    expect(useShowcase.getState().mapFocus).toBeNull();
  });
});

describe("the toggle carries the place across", () => {
  const regions = [{ id: "troms", name: "Troms", counties: ["Troms"], stations: ["3000014", "3000016"] }];
  beforeEach(() =>
    useShowcase.setState({ live: baseState(), regions, regionId: "troms", view: "overview", siteId: null, mode: "map", mapFocus: null, mapView: null }),
  );

  it("opens the diorama of the station the map is zoomed in on", () => {
    useShowcase.getState().setMapView({ lat: 69.135, lon: 20.76, zoom: 12 });
    useShowcase.getState().setMode("3d");
    expect(useShowcase.getState()).toMatchObject({ mode: "3d", view: "site", siteId: "3000014", regionId: "troms" });
  });

  it("centres the map on the diorama's station when switching back", () => {
    useShowcase.setState({ mode: "3d", view: "site", siteId: "3000016" });
    useShowcase.getState().setMode("map");
    expect(useShowcase.getState().mapFocus).toEqual({ lat: 69.18203, lon: 20.75035, zoom: 12 });
  });

  it("fits the map to the region of a 3D overview", () => {
    useShowcase.setState({ mode: "3d", view: "overview", siteId: null });
    useShowcase.getState().setMode("map");
    expect(useShowcase.getState().mapFocus).toEqual({ bounds: [[69.1202, 20.74511], [69.18203, 20.75035]] });
  });

  it("does nothing when the active view is chosen again", () => {
    useShowcase.getState().setMapView({ lat: 69.135, lon: 20.76, zoom: 12 });
    useShowcase.getState().setMode("map");
    expect(useShowcase.getState()).toMatchObject({ mode: "map", mapFocus: null, view: "overview" });
  });
});
