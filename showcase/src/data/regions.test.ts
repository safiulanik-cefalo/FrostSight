import { describe, it, expect } from "vitest";
import { inRegion, regionKpi, regionOfCounty, regionOfStation, type Region } from "./regions";
import { baseState } from "./fixtures";

const REGIONS: Region[] = [
  { id: "troms", name: "Troms", counties: ["Troms"], stations: ["3000014", "3000016"] },
  { id: "oslo-akershus", name: "Oslo and Akershus", counties: ["Oslo", "Akershus"], stations: ["100", "200"] },
];
const now = new Date("2026-10-12T09:40:00Z");

function twoRegions() {
  const s = baseState();
  s.stations.push(
    { ...s.stations[0], station_id: "100", name: "Ryen", road: "E6", county: "Oslo", risk_level: "VERY_HIGH", icing_score: 0.9 },
    { ...s.stations[1], station_id: "200", name: "Vinterbro", road: "E6", county: "Akershus" },
  );
  s.segments.push({ ...s.segments[0], road_segment_id: "o-1", station_id: "100", road: "E6", county: "Oslo", risk_level: "VERY_HIGH", icing_score: 0.9 });
  s.incidents = [
    { incident_id: "a", road: "E6", road_segment_id: null, county: "Akershus", incident_type: "MAINTENANCEWORKS", severity: null, start_time: "2026-10-12T05:00:00Z", end_time: null, description: null },
    { incident_id: "b", road: "E6", road_segment_id: null, county: "Oslo", incident_type: "MAINTENANCEWORKS", severity: null, start_time: "2026-10-12T05:00:00Z", end_time: "2026-10-12T06:00:00Z", description: null },
  ];
  return s;
}

describe("regions", () => {
  it("finds a station's region and a county's region", () => {
    expect(regionOfStation(REGIONS, "200")?.id).toBe("oslo-akershus");
    expect(regionOfStation(REGIONS, "nope")).toBeUndefined();
    expect(regionOfCounty(REGIONS, "Oslo")?.id).toBe("oslo-akershus");
  });

  it("reads rows without a county as Troms, the only county before the column existed", () => {
    expect(inRegion(REGIONS[0], undefined)).toBe(true);
    expect(inRegion(REGIONS[1], undefined)).toBe(false);
    expect(inRegion(null, "Oslo")).toBe(true);
  });

  it("counts the counters for one region from its rows", () => {
    expect(regionKpi(twoRegions(), REGIONS[1], now)).toEqual({
      segments_total: 1, segments_high: 1, segments_very_high: 1, stations_total: 2, stations_reporting: 1, active_incidents: 1,
    });
    expect(regionKpi(twoRegions(), REGIONS[0], now)).toMatchObject({ segments_total: 1, segments_high: 1, stations_total: 2 });
  });
});
