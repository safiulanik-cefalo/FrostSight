import { describe, it, expect } from "vitest";
import { filterSites, siteSummary, kpiNarrow, liveChip } from "./format";
import { baseState } from "../data/fixtures";

const sites = [
  { station_id: "1", name: "Skattørsund", road: "Fv866" },
  { station_id: "2", name: "Bossovarri", road: "E8" },
  { station_id: "3", name: "Lavangsdalen", road: "E8" },
];

describe("filterSites", () => {
  it("matches name or road, ignoring case and accents", () => {
    expect(filterSites(sites, "skatt").map((s) => s.station_id)).toEqual(["1"]);
    expect(filterSites(sites, "SKATTØR").map((s) => s.station_id)).toEqual(["1"]);
    expect(filterSites(sites, "e8").map((s) => s.station_id)).toEqual(["2", "3"]);
    expect(filterSites(sites, "  ")).toHaveLength(3);
  });
});

describe("siteSummary", () => {
  it("names the level and score, or says there is no current risk", () => {
    expect(siteSummary(baseState(), "3000014")).toBe("High · icing 0.72");
    expect(siteSummary(baseState(), "3000016")).toBe("No current risk");
  });
});

describe("kpiNarrow", () => {
  it("counts segments at HIGH or above on the station's road", () => {
    const s = baseState();
    s.segments.push({ ...s.segments[0], road_segment_id: "x", station_id: "9", risk_level: "LOW", road: "E8" });
    s.segments.push({ ...s.segments[0], road_segment_id: "y", station_id: "8", risk_level: "VERY_HIGH", road: "E6" });
    expect(kpiNarrow(s, "3000014")).toEqual({ road: "E8", high: 1, total: 2 });
  });
});

describe("liveChip", () => {
  const now = new Date("2026-10-12T09:32:00Z");
  it("says live, snapshot or simulated, with the data age", () => {
    expect(liveChip(baseState(), "live", now)).toEqual({ tone: "live", text: "Live · 12 min old" });
    expect(liveChip({ ...baseState(), source: "snapshot" }, "snapshot", now)).toEqual({ tone: "snapshot", text: "Snapshot · 12 min old" });
    const sim = { ...baseState(), source: "scenario" as const, scenario: { id: "s", title: "Snowstorm on E8", step_s: 3 } };
    expect(liveChip(sim, "live", now)).toEqual({ tone: "simulated", text: "Simulated · Snowstorm on E8" });
  });
});
