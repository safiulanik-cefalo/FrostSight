// SPIKE (throwaway): the baked land-cover grid (public/sites/<id>/cover.bin, from tools/bake_places.py).
// One byte per cell over the site's terrain box, row 0 north (-z), same codes as the bake script's CLASSES.
export const COVER = {
  UNMAPPED: 0,
  BUILT: 1,
  ROAD: 2,
  FARM: 3,
  FOREST_LEAF: 4,
  FOREST_CONIFER: 5,
  FOREST_MIXED: 6,
  BOG: 7,
  OPEN: 8,
  FRESHWATER: 9,
  SEA: 10,
  GLACIER: 11,
} as const;

export type CoverGrid = { n: number; cells: Uint8Array; sizeM: number };

export function decodeCover(buf: ArrayBuffer, sizeM: number): CoverGrid {
  const cells = new Uint8Array(buf);
  return { n: Math.round(Math.sqrt(cells.length)), cells, sizeM };
}

/** Class at metres east (x) and south (z) of the site centre; nearest cell. */
export function coverAt(g: CoverGrid, xM: number, zM: number): number {
  const last = g.n - 1;
  const j = Math.max(0, Math.min(last, Math.round((xM / g.sizeM + 0.5) * last)));
  const i = Math.max(0, Math.min(last, Math.round((zM / g.sizeM + 0.5) * last)));
  return g.cells[i * g.n + j];
}

export const isForest = (c: number): boolean => c === COVER.FOREST_LEAF || c === COVER.FOREST_CONIFER || c === COVER.FOREST_MIXED;

/** Share of the 3x3 neighbourhood that is built up: 1 in a town centre, lower at the edge. */
export function builtDensity(g: CoverGrid, i: number, j: number): number {
  let k = 0;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const ii = i + di;
      const jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < g.n && jj < g.n && g.cells[ii * g.n + jj] === COVER.BUILT) k++;
    }
  }
  return k / 9;
}
