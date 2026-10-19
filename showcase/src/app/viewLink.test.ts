import { describe, it, expect } from "vitest";
import { mapTarget, threeDTarget } from "./viewLink";
import { baseState } from "../data/fixtures";
import type { Region } from "../data/regions";
import type { Station } from "../../shared/contract";

const fokstugu: Station = { ...baseState().stations[0], station_id: "529015", name: "Fokstugu", road: "E6", county: "Innlandet", lat: 62.1136, lon: 9.2869 };
const stations = [...baseState().stations, fokstugu];
const regions: Region[] = [
  { id: "troms", name: "Troms", counties: ["Troms"], stations: ["3000014", "3000016"] },
  { id: "innlandet", name: "Innlandet", counties: ["Innlandet"], stations: ["529015"] },
];

describe("threeDTarget", () => {
  it("opens the diorama of a station near the centre when zoomed in", () => {
    // about 2 km from Bossovarri on the E8
    expect(threeDTarget({ lat: 69.135, lon: 20.76, zoom: 12 }, stations, regions, "innlandet")).toEqual({ view: "site", id: "3000014" });
  });

  it("opens the region overview when the nearest station is too far for a diorama", () => {
    // Hamar is about 140 km from Fokstugu
    expect(threeDTarget({ lat: 60.7945, lon: 11.068, zoom: 12 }, stations, regions, "troms")).toEqual({ view: "overview", region: "innlandet" });
  });

  it("opens the overview of the nearest station's region at county zoom", () => {
    expect(threeDTarget({ lat: 69.13, lon: 20.75, zoom: 9 }, stations, regions, "innlandet")).toEqual({ view: "overview", region: "troms" });
  });

  it("falls back to the nearest region for a centre outside the monitored counties", () => {
    // Bergen
    expect(threeDTarget({ lat: 60.39, lon: 5.32, zoom: 9 }, stations, regions, "troms")).toEqual({ view: "overview", region: "innlandet" });
  });

  it("keeps the current region when the map shows the whole country or has not moved", () => {
    expect(threeDTarget({ lat: 65, lon: 15, zoom: 5 }, stations, regions, "innlandet")).toEqual({ view: "overview", region: "innlandet" });
    expect(threeDTarget(null, stations, regions, "troms")).toEqual({ view: "overview", region: "troms" });
  });

  it("only opens dioramas that exist, for stations listed in a region", () => {
    const unbaked = { ...fokstugu, station_id: "999", lat: 69.135, lon: 20.76 };
    expect(threeDTarget({ lat: 69.135, lon: 20.76, zoom: 12 }, [unbaked, ...stations], regions, "troms")).toEqual({ view: "site", id: "3000014" });
  });
});

describe("mapTarget", () => {
  it("centres on a diorama's station at street zoom", () => {
    expect(mapTarget({ view: "site", siteId: "529015", regionId: "innlandet" }, stations, regions)).toEqual({ lat: 62.1136, lon: 9.2869, zoom: 12 });
  });

  it("fits an overview's region", () => {
    expect(mapTarget({ view: "overview", siteId: null, regionId: "troms" }, stations, regions)).toEqual({
      bounds: [
        [69.1202, 20.74511],
        [69.18203, 20.75035],
      ],
    });
  });

  it("has nothing to show for a region without known stations", () => {
    expect(mapTarget({ view: "overview", siteId: null, regionId: "nowhere" }, stations, regions)).toBeNull();
    expect(mapTarget({ view: "site", siteId: "nope", regionId: "nowhere" }, stations, regions)).toBeNull();
  });
});
