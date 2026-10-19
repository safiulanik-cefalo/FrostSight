import { lazy, Suspense, useEffect } from "react";
import { Hud } from "./app/Hud";
import { hashFor, readHash } from "./app/route";
import { useShowcase } from "./data/store";
import { MapView } from "./map/MapView";

const ThreeView = lazy(() => import("./scene/ThreeView"));

/** Keeps the URL hash and the store's view in step, so links and the back button work. */
function useHashRoute() {
  const goSite = useShowcase((s) => s.goSite);
  const goOverview = useShowcase((s) => s.goOverview);
  const setMode = useShowcase((s) => s.setMode);
  useEffect(() => {
    const follow = () => {
      const r = readHash(window.location.hash);
      const { mode, view, siteId, regionId } = useShowcase.getState();
      if (r.mode === "map") {
        if (mode !== "map") setMode("map");
        return;
      }
      if (mode !== "3d") setMode("3d");
      if (r.view === "site" && (view !== "site" || siteId !== r.id)) goSite(r.id);
      if (r.view === "overview" && (view !== "overview" || (r.region && r.region !== regionId))) goOverview(r.region ?? undefined);
    };
    follow();
    window.addEventListener("hashchange", follow);
    const unsub = useShowcase.subscribe((s) => {
      const want = hashFor(s);
      if (window.location.hash !== want) window.location.hash = want;
    });
    return () => {
      window.removeEventListener("hashchange", follow);
      unsub();
    };
  }, [goSite, goOverview, setMode]);
}

export default function App() {
  const boot = useShowcase((s) => s.boot);
  const mode = useShowcase((s) => s.mode);
  useEffect(() => {
    boot();
  }, [boot]);
  useHashRoute();
  return (
    <>
      {mode === "map" ? (
        <MapView />
      ) : (
        <Suspense fallback={<div className="boot">Loading the 3D view…</div>}>
          <ThreeView />
        </Suspense>
      )}
      <Hud />
    </>
  );
}
