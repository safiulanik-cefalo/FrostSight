import { useEffect } from "react";
import { useShowcase } from "./data/store";
import { SceneCanvas } from "./scene/SceneCanvas";
import { Site } from "./scene/Site";

function readHash() {
  const m = /^#site=([\w-]+)$/.exec(window.location.hash);
  return m ? m[1] : null;
}

export default function App() {
  const boot = useShowcase((s) => s.boot);
  const siteId = useShowcase((s) => s.siteId);
  const goSite = useShowcase((s) => s.goSite);
  useEffect(() => {
    boot();
    const follow = () => {
      const id = readHash();
      if (id) goSite(id);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [boot, goSite]);
  return <SceneCanvas>{siteId && <Site stationId={siteId} />}</SceneCanvas>;
}
