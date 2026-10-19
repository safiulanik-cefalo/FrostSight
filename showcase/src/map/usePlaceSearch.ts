import { useEffect, useState } from "react";
import { placeSearchUrl, searchPlaces, type Place } from "./places";

const PAUSE_MS = 250;

/** Towns for what the viewer is typing: asked after a short pause, the previous request cancelled. */
export function usePlaceSearch(query: string, enabled: boolean): { places: Place[]; searching: boolean } {
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!enabled || !placeSearchUrl(query)) {
      setPlaces([]);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      searchPlaces(query, fetch, ctrl.signal).then((found) => {
        if (ctrl.signal.aborted) return;
        setPlaces(found);
        setSearching(false);
      });
    }, PAUSE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, enabled]);
  return { places, searching };
}
