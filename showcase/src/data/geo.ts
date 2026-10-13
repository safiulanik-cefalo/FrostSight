// Latitude and longitude to the baked scene's local metres, the same equirectangular projection as
// tools/bake_sites.py project_local: x is metres east of the origin, z metres south (north is negative z).
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQ = 111320;

export function projectLocal(lat: number, lon: number, origin: { lat: number; lon: number }): [number, number] {
  const x = (lon - origin.lon) * Math.cos((origin.lat * Math.PI) / 180) * M_PER_DEG_LON_EQ;
  const z = -(lat - origin.lat) * M_PER_DEG_LAT;
  return [x, z];
}

/** The point on a polyline nearest (x, z): its distance along the line and how far off the line (x, z) is. */
export function nearestAlong(points: [number, number][], x: number, z: number): { atM: number; offsetM: number } {
  let best = { atM: 0, offsetM: Infinity };
  let walked = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (z - z0) * (z1 - z0)) / (len * len)));
    const d = Math.hypot(x - (x0 + (x1 - x0) * t), z - (z0 + (z1 - z0) * t));
    if (d < best.offsetM) best = { atM: walked + t * len, offsetM: d };
    walked += len;
  }
  return best;
}
