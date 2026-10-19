import { describe, it, expect } from "vitest";
import { parsePlaces, placeSearchUrl, searchPlaces } from "./places";
import ham from "./fixtures/places_ham.json";

describe("placeSearchUrl", () => {
  it("asks for up to 500 trimmed prefix matches", () => {
    const url = new URL(placeSearchUrl("Ham")!);
    expect(url.origin + url.pathname).toBe("https://ws.geonorge.no/stedsnavn/v1/navn");
    expect(url.searchParams.get("sok")).toBe("Ham*");
    expect(url.searchParams.get("fuzzy")).toBe("false");
    expect(url.searchParams.get("utkoordsys")).toBe("4258");
    expect(url.searchParams.get("treffPerSide")).toBe("500");
    expect(url.searchParams.get("filtrer")).toContain("navn.navneobjekttype");
  });

  it("waits for two letters and drops wildcards the viewer typed", () => {
    expect(placeSearchUrl("H")).toBeNull();
    expect(placeSearchUrl(" * ")).toBeNull();
    expect(new URL(placeSearchUrl(" tr*om ")!).searchParams.get("sok")).toBe("trom*");
  });
});

describe("parsePlaces", () => {
  it("keeps towns only, once each, towns before municipalities", () => {
    expect(parsePlaces(ham, "ham")).toEqual([
      { name: "Hamar", kind: "Town", municipality: "Hamar", lat: 60.79451, lon: 11.06795, zoom: 11 },
      { name: "Hammerfest", kind: "Town", municipality: "Hammerfest", lat: 70.66336, lon: 23.68206, zoom: 11 },
      { name: "Hamnvik", kind: "Settlement", municipality: "Ibestad", lat: 68.77927, lon: 17.17179, zoom: 12 },
      { name: "Hamar kommune", kind: "Municipality", municipality: "Hamar", lat: 60.7945, lon: 11.0783, zoom: 10 },
    ]);
  });

  it("puts an exact name first", () => {
    expect(parsePlaces(ham, "hammerfest")[0].name).toBe("Hammerfest");
  });

  it("leaves out places outside Norway, which have no municipality", () => {
    const abroad = { navn: [{ skrivemåte: "Hamburgsund", navneobjekttype: "Tettsted", representasjonspunkt: { nord: 58.55, øst: 11.27 } }, ...ham.navn] };
    expect(parsePlaces(abroad, "ham").map((p) => p.name)).not.toContain("Hamburgsund");
  });

  it("returns at most five", () => {
    const many = { navn: Array.from({ length: 9 }, (_, i) => ({ ...ham.navn[1], skrivemåte: `Town ${i}` })) };
    expect(parsePlaces(many, "town")).toHaveLength(5);
  });

  it("returns nothing for a response it does not recognise", () => {
    expect(parsePlaces(null, "ham")).toEqual([]);
    expect(parsePlaces({ navn: [{ skrivemåte: "Hamar", navneobjekttype: "By" }] }, "ham")).toEqual([]);
  });
});

describe("searchPlaces", () => {
  it("parses a good answer", async () => {
    const fetchFn = (async () => new Response(JSON.stringify(ham))) as unknown as typeof fetch;
    expect((await searchPlaces("ham", fetchFn)).map((p) => p.name)).toEqual(["Hamar", "Hammerfest", "Hamnvik", "Hamar kommune"]);
  });

  it("returns nothing when the service fails, so station search still works", async () => {
    const down = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    const offline = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await searchPlaces("ham", down)).toEqual([]);
    expect(await searchPlaces("ham", offline)).toEqual([]);
    expect(await searchPlaces("h", down)).toEqual([]);
  });
});
