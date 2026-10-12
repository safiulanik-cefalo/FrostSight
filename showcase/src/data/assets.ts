// Static scene assets baked by tools/bake_sites.py: the road corridor and the terrain heightmap per site,
// and the county overview.
export type RoadJson = {
  station_id: string;
  name: string;
  road: string;
  climate: string;
  road_segment_id: string;
  origin: { lat: number; lon: number };
  points: [number, number][];
  station_at_m: number;
  length_m: number;
  km_marks: Array<{ at_m: number; label: string }>;
  terrain: { n: number; size_m: number; min_m: number; max_m: number };
};
export type SiteAssets = { road: RoadJson; heights: Float32Array };

export type OverviewAssets = {
  county: { origin: { lat: number; lon: number }; rings: [number, number][][]; terrain: RoadJson["terrain"] };
  roads: Array<{ road: string; points: [number, number][] }>;
  stations: Array<{ station_id: string; name: string; climate: string; road: string; xz: [number, number] }>;
  heights: Float32Array;
};

export function decodeHeights(buf: ArrayBuffer, minM: number, maxM: number): Float32Array {
  const view = new DataView(buf);
  const out = new Float32Array(buf.byteLength / 2);
  const span = maxM - minM;
  for (let i = 0; i < out.length; i++) out[i] = minM + (view.getUint16(i * 2, true) / 65535) * span;
  return out;
}

const siteCache = new Map<string, Promise<SiteAssets>>();

export function loadSiteAssets(stationId: string, fetchFn: typeof fetch = fetch): Promise<SiteAssets> {
  let p = siteCache.get(stationId);
  if (!p) {
    p = (async () => {
      // the static host answers unknown paths with index.html and 200, so check the type, not only the status
      const r = await fetchFn(`/sites/${stationId}/road.json`);
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) throw new Error(`Unknown station ${stationId}`);
      const road = (await r.json()) as RoadJson;
      const t = await fetchFn(`/sites/${stationId}/terrain.bin`);
      if (!t.ok) throw new Error(`Terrain missing for station ${stationId}`);
      return { road, heights: decodeHeights(await t.arrayBuffer(), road.terrain.min_m, road.terrain.max_m) };
    })();
    p.catch(() => siteCache.delete(stationId));
    siteCache.set(stationId, p);
  }
  return p;
}

let overview: Promise<OverviewAssets> | null = null;

export function loadOverviewAssets(fetchFn: typeof fetch = fetch): Promise<OverviewAssets> {
  overview ??= (async () => {
    const [county, roads, stations, buf] = await Promise.all([
      fetchFn("/overview/county.json").then((r) => r.json() as Promise<OverviewAssets["county"]>),
      fetchFn("/overview/roads.json").then((r) => r.json() as Promise<OverviewAssets["roads"]>),
      fetchFn("/overview/stations.json").then((r) => r.json() as Promise<OverviewAssets["stations"]>),
      fetchFn("/overview/terrain.bin").then((r) => r.arrayBuffer()),
    ]);
    return { county, roads, stations, heights: decodeHeights(buf, county.terrain.min_m, county.terrain.max_m) };
  })();
  return overview;
}
