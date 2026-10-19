// The 3D scene: the region overview or a station's diorama. Loaded on demand, so the 2D map never
// downloads three.js.
import { useMemo } from "react";
import { useShowcase } from "../data/store";
import { closuresAt } from "../data/scenario";
import { Overview } from "./Overview";
import { SceneCanvas } from "./SceneCanvas";
import { ScenarioClock } from "./ScenarioClock";
import { Site } from "./Site";

export default function ThreeView() {
  const view = useShowcase((s) => s.view);
  const siteId = useShowcase((s) => s.siteId);
  const regionId = useShowcase((s) => s.regionId);
  const scenario = useShowcase((s) => s.scenario);
  const clock = useShowcase((s) => Math.floor(s.clockS));
  // keyed by content: a new array with the same closures every second must not rebuild the road or reset the cars
  const closuresKey = scenario ? JSON.stringify(closuresAt(scenario, clock)) : "[]";
  const closures = useMemo(() => JSON.parse(closuresKey) as ReturnType<typeof closuresAt>, [closuresKey]);
  return (
    <SceneCanvas wide={view === "overview"}>
      <ScenarioClock />
      {view === "site" && siteId ? <Site key={siteId} stationId={siteId} scenarioClosures={closures} /> : <Overview key={regionId} regionId={regionId} />}
    </SceneCanvas>
  );
}
