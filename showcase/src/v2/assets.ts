// SPIKE (throwaway): v1 site assets plus the baked cover grid and place names. Sites without them (not yet
// baked) load as v1 with no cover and no labels.
import { loadSiteAssets, type SiteAssets } from "../data/assets";
import { decodeCover, type CoverGrid } from "./cover";

export type PlaceKind =
  | "town" | "district" | "village" | "bridge" | "tunnel" | "island" | "fjord" | "sound"
  | "peak" | "valley" | "lake" | "river" | "cape" | "landmark"; // prettier-ignore
export type Place = { name: string; kind: PlaceKind; tier: 1 | 2 | 3; xz: [number, number] };
export type PlacesJson = { n: number; places: Place[]; attribution: string[] };
export type SiteAssetsV2 = SiteAssets & { cover: CoverGrid | null; places: Place[]; attribution: string[] };

const cache = new Map<string, Promise<SiteAssetsV2>>();

export function loadSiteAssetsV2(stationId: string, fetchFn: typeof fetch = fetch): Promise<SiteAssetsV2> {
  let p = cache.get(stationId);
  if (!p) {
    p = (async () => {
      const base = await loadSiteAssets(stationId, fetchFn);
      try {
        const [c, pl] = await Promise.all([fetchFn(`/sites/${stationId}/cover.bin`), fetchFn(`/sites/${stationId}/places.json`)]);
        // the static host answers unknown paths with index.html and 200, so check the type, not only the status
        if (!c.ok || !pl.ok || !(pl.headers.get("content-type") ?? "").includes("json")) throw new Error("not baked");
        const places = (await pl.json()) as PlacesJson;
        const cover = decodeCover(await c.arrayBuffer(), base.road.terrain.size_m);
        return { ...base, cover, places: places.places, attribution: places.attribution };
      } catch {
        return { ...base, cover: null, places: [], attribution: [] };
      }
    })();
    p.catch(() => cache.delete(stationId));
    cache.set(stationId, p);
  }
  return p;
}
