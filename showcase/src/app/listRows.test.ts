import { describe, it, expect } from "vitest";
import { segmentRows, stationRows, incidentRows, driverChip, incidentLabel } from "./listRows";
import { baseState } from "../data/fixtures";
import type { State } from "../../shared/contract";

function richer(): State {
  const s = baseState();
  const seg = s.segments[0];
  s.segments.push({ ...seg, road_segment_id: "e8-low", station_id: "x1", segment: "E8 · Skibotn", risk_level: "LOW", icing_score: 0.2 });
  s.segments.push({ ...seg, road_segment_id: "e6-vh", station_id: "x2", segment: "E6 · Heia", road: "E6", risk_level: "VERY_HIGH", icing_score: 0.95 });
  s.stations.push({ ...s.stations[0], station_id: "x2", name: "Heia", road: "E6", status: "Reporting", risk_level: "VERY_HIGH", icing_score: 0.95 });
  s.incidents = [
    { incident_id: "a", road: "E8", road_segment_id: "1125788-27-9", station_id: "3000014", station_km: 0.8, lat: 69.13, lon: 20.76, incident_type: "roadClosed", severity: null, start_time: "2026-10-12T08:00:00Z", end_time: null, description: "Closed" },
    { incident_id: "b", road: "E8", road_segment_id: null, station_id: null, station_km: 12.4, lat: 69.3, lon: 20.1, incident_type: "accident", severity: null, start_time: "2026-10-12T05:00:00Z", end_time: "2026-10-12T06:00:00Z", description: null },
    { incident_id: "c", road: "E6", road_segment_id: "e6-vh", incident_type: "roadworks", severity: null, start_time: "2026-10-12T05:00:00Z", end_time: null, description: null },
  ];
  return s;
}
const now = new Date("2026-10-12T09:40:00Z");

describe("segmentRows", () => {
  it("lists every segment on the overview, highest score first", () => {
    expect(segmentRows(richer(), null, now).map((r) => r.id)).toEqual(["e6-vh", "1125788-27-9", "e8-low"]);
  });
  it("lists only the site's road on a site and marks an active closure", () => {
    const rows = segmentRows(richer(), "3000014", now);
    expect(rows.map((r) => r.id)).toEqual(["1125788-27-9", "e8-low"]);
    expect(rows[0]).toMatchObject({ title: "Bossovarri", level: "HIGH", score: 0.72, closed: true });
    expect(rows[1].closed).toBe(false);
  });
});

describe("stationRows", () => {
  it("puts stale stations last and keeps the road filter on a site", () => {
    expect(stationRows(richer(), null).map((r) => r.id)).toEqual(["3000014", "x2", "3000016"]);
    expect(stationRows(richer(), "3000014").map((r) => r.id)).toEqual(["3000014", "3000016"]);
    expect(stationRows(richer(), null)[2]).toMatchObject({ level: "NONE", reporting: false });
  });
});

describe("incidentRows", () => {
  it("marks open incidents active, ended ones not, and filters by the site's road", () => {
    const rows = incidentRows(richer(), "3000014", now);
    expect(rows.map((r) => [r.id, r.active])).toEqual([["a", true], ["b", false]]);
    expect(incidentRows(richer(), null, now)).toHaveLength(3);
  });
  it("lists active incidents first, those near a station before the rest, newest first", () => {
    const s = richer();
    s.incidents.push({ ...s.incidents[1], incident_id: "d", end_time: null, start_time: "2026-10-12T09:00:00Z" });
    expect(incidentRows(s, null, now).map((r) => r.id)).toEqual(["a", "d", "c", "b"]);
  });
  it("says where each incident is, so the row can take the viewer there", () => {
    const rows = incidentRows(richer(), null, now);
    const [a, b, c] = ["a", "b", "c"].map((id) => rows.find((r) => r.id === id));
    expect(a).toMatchObject({ stationId: "3000014", located: true, where: "0.8 km from Bossovarri" });
    expect(b).toMatchObject({ stationId: null, located: true, where: "No station within 5 km" });
    expect(c).toMatchObject({ stationId: null, located: false, where: null });
  });
});

describe("driverChip", () => {
  it("grades a driver's contribution", () => {
    expect(driverChip(0.41)).toBe("Driver");
    expect(driverChip(0.25)).toBe("Driver");
    expect(driverChip(0.12)).toBe("Rising");
    expect(driverChip(0.05)).toBe("Minor");
  });
});

describe("rows for a site the state does not list", () => {
  it("shows nothing instead of the whole county, or uses the baked road when given", () => {
    expect(segmentRows(richer(), "1900113", now)).toEqual([]);
    expect(stationRows(richer(), "1900113")).toEqual([]);
    expect(incidentRows(richer(), "1900113", now)).toEqual([]);
    expect(segmentRows(richer(), "1900113", now, "E6").map((r) => r.id)).toEqual(["e6-vh"]);
  });
  it("marks scenario incidents as simulated", () => {
    const s = richer();
    s.incidents.push({ ...s.incidents[0], incident_id: "sim-x" });
    const rows = incidentRows(s, null, now);
    expect(rows.find((r) => r.id === "sim-x")?.simulated).toBe(true);
    expect(rows.find((r) => r.id === "a")?.simulated).toBe(false);
  });
});

describe("incidentLabel", () => {
  it("names the DATEX record types in plain words", () => {
    expect(incidentLabel("MAINTENANCEWORKS")).toBe("Roadworks");
    expect(incidentLabel("ROADORCARRIAGEWAYORLANEMANAGEMENT")).toBe("Lane or road restriction");
    expect(incidentLabel("REROUTINGMANAGEMENT")).toBe("Diversion");
    expect(incidentLabel("GENERALNETWORKMANAGEMENT")).toBe("Traffic management");
    expect(incidentLabel("SPEEDMANAGEMENT")).toBe("Speed restriction");
    expect(incidentLabel("roadClosed")).toBe("Road closed");
    expect(incidentLabel("SOMETHINGNEW")).toBe("Somethingnew");
  });
});
