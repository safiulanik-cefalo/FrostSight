import { useEffect } from "react";
import { useShowcase } from "./data/store";
import { Overview } from "./scene/Overview";
import { SceneCanvas } from "./scene/SceneCanvas";
import { Site } from "./scene/Site";

function readHash(): { view: "overview" } | { view: "site"; id: string } {
  const m = /^#site=([\w-]+)$/.exec(window.location.hash);
  return m ? { view: "site", id: m[1] } : { view: "overview" };
}

/** Keeps the URL hash and the store's view in step, so links and the back button work. */
function useHashRoute() {
  const goSite = useShowcase((s) => s.goSite);
  const goOverview = useShowcase((s) => s.goOverview);
  useEffect(() => {
    const follow = () => {
      const r = readHash();
      const { view, siteId } = useShowcase.getState();
      if (r.view === "site" && (view !== "site" || siteId !== r.id)) goSite(r.id);
      if (r.view === "overview" && view !== "overview") goOverview();
    };
    follow();
    window.addEventListener("hashchange", follow);
    const unsub = useShowcase.subscribe((s) => {
      const want = s.view === "site" && s.siteId ? `#site=${s.siteId}` : "#overview";
      if (window.location.hash !== want) window.location.hash = want;
    });
    return () => {
      window.removeEventListener("hashchange", follow);
      unsub();
    };
  }, [goSite, goOverview]);
}

export default function App() {
  const boot = useShowcase((s) => s.boot);
  const view = useShowcase((s) => s.view);
  const siteId = useShowcase((s) => s.siteId);
  useEffect(() => {
    boot();
  }, [boot]);
  useHashRoute();
  return <SceneCanvas wide={view === "overview"}>{view === "site" && siteId ? <Site key={siteId} stationId={siteId} /> : <Overview />}</SceneCanvas>;
}
