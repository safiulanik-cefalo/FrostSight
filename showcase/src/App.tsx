import { useEffect, useMemo } from "react";
import { Hud } from "./app/Hud";
import { useShowcase } from "./data/store";
import { Overview } from "./scene/Overview";
import { SceneCanvas } from "./scene/SceneCanvas";
import { ScenarioClock } from "./scene/ScenarioClock";
import { Site, type SiteVariant } from "./scene/Site";
import { closuresAt } from "./data/scenario";

type Route = { view: "overview"; region: string | null } | { view: "site"; id: string };

/** #site=<station>, #region=<region>, or #overview (the current region). */
function readHash(): Route {
  const site = /^#site=([\w-]+)$/.exec(window.location.hash);
  if (site) return { view: "site", id: site[1] };
  const region = /^#region=([\w-]+)$/.exec(window.location.hash);
  return { view: "overview", region: region ? region[1] : null };
}

/** Keeps the URL hash and the store's view in step, so links and the back button work. */
function useHashRoute() {
  const goSite = useShowcase((s) => s.goSite);
  const goOverview = useShowcase((s) => s.goOverview);
  useEffect(() => {
    const follow = () => {
      const r = readHash();
      const { view, siteId, regionId } = useShowcase.getState();
      if (r.view === "site" && (view !== "site" || siteId !== r.id)) goSite(r.id);
      if (r.view === "overview" && (view !== "overview" || (r.region && r.region !== regionId))) goOverview(r.region ?? undefined);
    };
    follow();
    window.addEventListener("hashchange", follow);
    const unsub = useShowcase.subscribe((s) => {
      const want = s.view === "site" && s.siteId ? `#site=${s.siteId}` : `#region=${s.regionId}`;
      if (window.location.hash !== want) window.location.hash = want;
    });
    return () => {
      window.removeEventListener("hashchange", follow);
      unsub();
    };
  }, [goSite, goOverview]);
}

/** The whole page. The /v2/ entry passes its site variant; the root page uses the base one. */
export default function App({ siteVariant }: { siteVariant?: SiteVariant } = {}) {
  const boot = useShowcase((s) => s.boot);
  const view = useShowcase((s) => s.view);
  const siteId = useShowcase((s) => s.siteId);
  const regionId = useShowcase((s) => s.regionId);
  const scenario = useShowcase((s) => s.scenario);
  const clock = useShowcase((s) => Math.floor(s.clockS));
  // keyed by content: a new array with the same closures every second must not rebuild the road or reset the cars
  const closuresKey = scenario ? JSON.stringify(closuresAt(scenario, clock)) : "[]";
  const closures = useMemo(() => JSON.parse(closuresKey) as ReturnType<typeof closuresAt>, [closuresKey]);
  useEffect(() => {
    boot();
  }, [boot]);
  useHashRoute();
  return (
    <>
      <SceneCanvas wide={view === "overview"}>
        <ScenarioClock />
        {view === "site" && siteId ? <Site key={siteId} stationId={siteId} scenarioClosures={closures} variant={siteVariant} /> : <Overview key={regionId} regionId={regionId} />}
      </SceneCanvas>
      <Hud />
    </>
  );
}
