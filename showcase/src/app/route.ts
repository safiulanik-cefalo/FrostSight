// The URL hash and the view on screen. The 2D map is the default; the 3D links from before it keep working.
export type Mode = "map" | "3d";
export type Route =
  | { mode: "map" }
  | { mode: "3d"; view: "overview"; region: string | null }
  | { mode: "3d"; view: "site"; id: string };

/** #site=<station> and #region=<region> or #overview open 3D; #map or anything else opens the map. */
export function readHash(hash: string): Route {
  const site = /^#site=([\w-]+)$/.exec(hash);
  if (site) return { mode: "3d", view: "site", id: site[1] };
  const region = /^#region=([\w-]+)$/.exec(hash);
  if (region) return { mode: "3d", view: "overview", region: region[1] };
  if (hash === "#overview") return { mode: "3d", view: "overview", region: null };
  return { mode: "map" };
}

export function hashFor(s: { mode: Mode; view: "overview" | "site"; siteId: string | null; regionId: string }): string {
  if (s.mode === "map") return "#map";
  return s.view === "site" && s.siteId ? `#site=${s.siteId}` : `#region=${s.regionId}`;
}
