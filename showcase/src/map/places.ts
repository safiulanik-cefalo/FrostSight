// Town search for the 2D map through Kartverket's place-name service (Stedsnavn API, CC BY 4.0). The service
// has no type filter, so one prefix request asks for up to 500 trimmed hits and the towns are picked here.
export type Place = { name: string; kind: string; municipality: string; lat: number; lon: number; zoom: number };

const ENDPOINT = "https://ws.geonorge.no/stedsnavn/v1/navn";
const FIELDS = "navn.skrivemåte,navn.navneobjekttype,navn.representasjonspunkt,navn.kommuner.kommunenavn";
const LIMIT = 5;
/** The service usually answers in about a second; past this the box shows stations and roads alone. */
const TIMEOUT_MS = 6000;

/** The place types a driver heads for, in the order they rank, with a label and a zoom that shows nearby roads. */
const TOWN_TYPES: Record<string, { kind: string; rank: number; zoom: number }> = {
  By: { kind: "Town", rank: 0, zoom: 11 },
  Tettsted: { kind: "Settlement", rank: 1, zoom: 12 },
  Tettbebyggelse: { kind: "Settlement", rank: 2, zoom: 12 },
  Kommune: { kind: "Municipality", rank: 3, zoom: 10 },
  Bygd: { kind: "Village", rank: 4, zoom: 12 },
  Grend: { kind: "Hamlet", rank: 5, zoom: 13 },
};

/** The request for a typed prefix, or null until there are two letters. */
export function placeSearchUrl(query: string, opts?: { fuzzy?: boolean }): string | null {
  const q = query.replace(/\*/g, "").trim();
  if (q.length < 2) return null;
  const params = new URLSearchParams({
    sok: `${q}*`,
    fuzzy: opts?.fuzzy ? "true" : "false",
    utkoordsys: "4258",
    treffPerSide: "500",
    side: "1",
    filtrer: FIELDS,
  });
  return `${ENDPOINT}?${params}`;
}

type Hit = {
  skrivemåte?: unknown;
  navneobjekttype?: unknown;
  representasjonspunkt?: { nord?: unknown; øst?: unknown };
  kommuner?: Array<{ kommunenavn?: unknown }>;
};

/** Towns from a response: exact name first, then by type and name; each town once; at most five. */
export function parsePlaces(json: unknown, query: string): Place[] {
  const hits = (json as { navn?: unknown } | null)?.navn;
  if (!Array.isArray(hits)) return [];
  const q = query.replace(/\*/g, "").trim().toLowerCase();
  const seen = new Set<string>();
  const places: Array<Place & { rank: number }> = [];
  for (const h of hits as Hit[]) {
    const type = TOWN_TYPES[String(h.navneobjekttype)];
    const lat = h.representasjonspunkt?.nord;
    const lon = h.representasjonspunkt?.øst;
    if (!type || typeof h.skrivemåte !== "string" || typeof lat !== "number" || typeof lon !== "number") continue;
    // the register also names some places abroad; those have no Norwegian municipality
    const municipality = h.kommuner?.[0]?.kommunenavn;
    if (typeof municipality !== "string" || !municipality) continue;
    const key = `${h.skrivemåte}|${type.kind}|${municipality}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({ name: h.skrivemåte, kind: type.kind, municipality, lat, lon, zoom: type.zoom, rank: type.rank });
  }
  const exact = (p: Place) => (p.name.toLowerCase() === q ? 0 : 1);
  return places
    .sort((a, b) => exact(a) - exact(b) || a.rank - b.rank || a.name.localeCompare(b.name, "nb"))
    .slice(0, LIMIT)
    .map(({ rank: _rank, ...p }) => p);
}

/** One request; null on a timeout, network error or non-OK response, distinct from an OK answer with no hits. */
async function fetchPlaces(query: string, fetchFn: typeof fetch, signal: AbortSignal | undefined, fuzzy: boolean): Promise<Place[] | null> {
  const url = placeSearchUrl(query, { fuzzy });
  if (!url) return [];
  const ctrl = new AbortController();
  const cancel = () => ctrl.abort();
  signal?.addEventListener("abort", cancel);
  const timer = setTimeout(cancel, TIMEOUT_MS);
  try {
    const r = await fetchFn(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return parsePlaces(await r.json(), query);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Towns for a typed prefix; nothing when the service is slow, down or the request is cancelled. The plain
 * prefix search is exact, so "Tromso" (typed without the ø) finds nothing; when that happens for a query
 * with no Norwegian letter already in it, retry once with fuzzy matching before giving up.
 */
export async function searchPlaces(query: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<Place[]> {
  const first = await fetchPlaces(query, fetchFn, signal, false);
  if (first === null) return [];
  if (first.length > 0 || /[æøåÆØÅ]/.test(query)) return first;
  const retried = await fetchPlaces(query, fetchFn, signal, true);
  return retried ?? [];
}
