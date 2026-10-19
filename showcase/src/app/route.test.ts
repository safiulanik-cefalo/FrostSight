import { describe, it, expect } from "vitest";
import { hashFor, readHash } from "./route";

describe("readHash", () => {
  it("opens the 2D map by default and on #map", () => {
    expect(readHash("")).toEqual({ mode: "map" });
    expect(readHash("#map")).toEqual({ mode: "map" });
    expect(readHash("#something-else")).toEqual({ mode: "map" });
  });

  it("keeps the 3D links working", () => {
    expect(readHash("#overview")).toEqual({ mode: "3d", view: "overview", region: null });
    expect(readHash("#region=innlandet")).toEqual({ mode: "3d", view: "overview", region: "innlandet" });
    expect(readHash("#site=3000016")).toEqual({ mode: "3d", view: "site", id: "3000016" });
  });
});

describe("hashFor", () => {
  it("writes the hash that reads back to the same view", () => {
    expect(hashFor({ mode: "map", view: "site", siteId: "3000016", regionId: "troms" })).toBe("#map");
    expect(hashFor({ mode: "3d", view: "site", siteId: "3000016", regionId: "troms" })).toBe("#site=3000016");
    expect(hashFor({ mode: "3d", view: "overview", siteId: null, regionId: "troms" })).toBe("#region=troms");
  });
});
