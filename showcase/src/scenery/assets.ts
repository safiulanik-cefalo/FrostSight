// Site assets with scenery: the base files plus the baked land-cover grid and place names (tools/bake_places.py).
// A site baked before those files existed loads with no cover and no labels, and gets the climate-based trees.
import { loadSiteAssets, type SiteAssets } from "../data/assets";
import { decodeCover, type CoverGrid } from "./cover";

export type PlaceKind =
  | "town" | "district" | "village" | "bridge" | "tunnel" | "island" | "fjord" | "sound"
  | "peak" | "valley" | "lake" | "river" | "cape" | "landmark"; // prettier-ignore
/** One label; the bake writes them in placement priority order. */
export type Place = { name: string; kind: PlaceKind; tier: 1 | 2 | 3; xz: [number, number] };
export type PlacesJson = { n: number; places: Place[]; attribution: string[] };
export type SceneryAssets = SiteAssets & { cover: CoverGrid | null; places: Place[] };

const cache = new Map<string, Promise<SceneryAssets>>();

export function loadSceneryAssets(stationId: string, fetchFn: typeof fetch = fetch): Promise<SceneryAssets> {
  let p = cache.get(stationId);
  if (!p) {
    p = (async () => {
      const base = await loadSiteAssets(stationId, fetchFn);
      const [c, pl] = await Promise.all([fetchFn(`/sites/${stationId}/cover.bin`), fetchFn(`/sites/${stationId}/places.json`)]);
      // the static host answers unknown paths with index.html and 200, so check the type, not only the status
      if (!c.ok || !pl.ok || !(pl.headers.get("content-type") ?? "").includes("json")) return { ...base, cover: null, places: [] };
      const places = (await pl.json()) as PlacesJson;
      const cover = decodeCover(await c.arrayBuffer(), base.road.terrain.size_m);
      return { ...base, cover, places: places.places };
    })();
    p.catch(() => cache.delete(stationId));
    cache.set(stationId, p);
  }
  return p;
}
