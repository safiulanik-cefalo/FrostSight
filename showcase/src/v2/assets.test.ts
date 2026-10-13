import { describe, expect, it } from "vitest";
import { hasPlaces, loadPlacesAssets } from "./assets";

const road = {
  station_id: "9",
  name: "Test",
  road: "E8",
  climate: "fjord",
  road_segment_id: "1",
  origin: { lat: 69, lon: 19 },
  points: [
    [0, 0],
    [25, 0],
  ],
  station_at_m: 0,
  length_m: 25,
  km_marks: [],
  terrain: { n: 2, size_m: 14000, min_m: 0, max_m: 10 },
};
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const bin = (bytes: number) => new Response(new Uint8Array(bytes), { headers: { "content-type": "application/octet-stream" } });

function host(baked: boolean): typeof fetch {
  return (async (url: string) => {
    if (url.endsWith("road.json")) return json(road);
    if (url.endsWith("terrain.bin")) return bin(8);
    if (!baked) return new Response("<!doctype html>", { headers: { "content-type": "text/html" } }); // SPA fallback
    if (url.endsWith("cover.bin")) return bin(4);
    return json({ n: 2, places: [{ name: "Tromsø", kind: "town", tier: 1, xz: [0, 0] }], attribution: [] });
  }) as typeof fetch;
}

describe("loadPlacesAssets", () => {
  it("adds the cover grid and labels to the base assets", async () => {
    const a = await loadPlacesAssets("baked", host(true));
    expect(hasPlaces(a)).toBe(true);
    expect(a.cover?.n).toBe(2);
    expect(a.cover?.sizeM).toBe(14000);
    expect(a.places.map((p) => p.name)).toEqual(["Tromsø"]);
    expect(a.road.name).toBe("Test");
  });
  it("falls back to no cover and no labels when the site was not baked", async () => {
    const a = await loadPlacesAssets("unbaked", host(false));
    expect(a.cover).toBeNull();
    expect(a.places).toEqual([]);
    expect(a.heights.length).toBe(4);
  });
});
