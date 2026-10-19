// Carries the place on screen across the Map | 3D toggle: a station or a region, not the camera. The 3D overview
// is one exaggerated plate per region and a diorama is not to scale, so no map zoom maps onto a 3D camera.
import type { Station } from "../../shared/contract";
import type { Region } from "../data/regions";

export type MapView = { lat: number; lon: number; zoom: number };
export type MapFocus = MapView | { bounds: [[number, number], [number, number]] };
export type ThreeDTarget = { view: "site"; id: string } | { view: "overview"; region: string };

/** From this map zoom a nearby station's diorama is what the viewer is looking at. */
const SITE_ZOOM = 11;
/** How far from the map's centre a station may be and still be the place on screen. */
const SITE_KM = 10;
/** Below this zoom the map shows more than one region, so the 3D view keeps the one it had. */
const REGION_ZOOM = 7;
const STATION_ZOOM = 12;

function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  return 111.2 * Math.hypot(aLat - bLat, (aLon - bLon) * Math.cos((aLat * Math.PI) / 180));
}

/** Where 3D opens for what the map shows: a diorama near the centre, the nearest region, or the current one. */
export function threeDTarget(view: MapView | null, stations: Station[], regions: Region[], currentRegion: string): ThreeDTarget {
  const keep: ThreeDTarget = { view: "overview", region: currentRegion };
  if (!view || view.zoom < REGION_ZOOM) return keep;
  // only stations a region lists have a baked diorama
  const nearest = stations
    .map((s) => ({ s, region: regions.find((r) => r.stations.includes(s.station_id)), d: km(view.lat, view.lon, s.lat, s.lon) }))
    .filter((c) => c.region)
    .sort((a, b) => a.d - b.d)[0];
  if (!nearest) return keep;
  if (view.zoom >= SITE_ZOOM && nearest.d <= SITE_KM) return { view: "site", id: nearest.s.station_id };
  return { view: "overview", region: nearest.region!.id };
}

/** Where the map opens for what 3D shows: the diorama's station up close, or the overview's region in full. */
export function mapTarget(
  three: { view: "overview" | "site"; siteId: string | null; regionId: string },
  stations: Station[],
  regions: Region[],
): MapFocus | null {
  if (three.view === "site" && three.siteId) {
    const s = stations.find((x) => x.station_id === three.siteId);
    return s ? { lat: s.lat, lon: s.lon, zoom: STATION_ZOOM } : null;
  }
  const ids = regions.find((r) => r.id === three.regionId)?.stations ?? [];
  const inRegion = stations.filter((s) => ids.includes(s.station_id));
  if (!inRegion.length) return null;
  const lats = inRegion.map((s) => s.lat);
  const lons = inRegion.map((s) => s.lon);
  return {
    bounds: [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ],
  };
}
