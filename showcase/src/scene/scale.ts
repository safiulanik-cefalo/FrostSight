// Diorama scale: terrain and the road path shrink to a 300-unit plate, while the road, cars, station and trees
// keep toy sizes in scene units (a 7 m road at true scale would be under a pixel wide).
export const SITE_SIZE = 300;
export const SITE_EXAGGERATION = 2.4;
export const siteUnitsPerMetre = (terrainSizeM: number) => SITE_SIZE / terrainSizeM;

export const ROAD = { asphalt: 3.4, shoulder: 5.2, band: 4.6, lift: 0.5 } as const;
/** Ambience cars move at speed_mps x TIME_WARP metres per second of wall time. */
export const TIME_WARP = 40;
