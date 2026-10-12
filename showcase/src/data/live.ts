// The live state from the Worker, or the committed snapshot when the Worker has nothing valid to give.
import { parseState, type State } from "../../shared/contract";

async function tryLoad(fetchFn: typeof fetch, url: string): Promise<State | null> {
  try {
    const r = await fetchFn(url);
    if (!r.ok) return null;
    return parseState(await r.json());
  } catch {
    return null;
  }
}

export async function loadState(fetchFn: typeof fetch = fetch): Promise<{ state: State; via: "live" | "snapshot" }> {
  const live = await tryLoad(fetchFn, "/api/state");
  if (live) return { state: live, via: "live" };
  const snap = await tryLoad(fetchFn, "/snapshot.json");
  if (snap) return { state: { ...snap, source: "snapshot" }, via: "snapshot" };
  throw new Error("No live state and no snapshot: start the Worker or restore public/snapshot.json");
}
