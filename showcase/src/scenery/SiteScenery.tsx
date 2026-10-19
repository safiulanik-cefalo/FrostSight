// A site's scenery beside the road, taken from the land so people who know the place can recognise it: trees by
// forest and species, toy houses on built-up land and place names. A site baked before the land-cover files
// existed gets the climate-based trees instead.
import { addAfterEffect, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import type { SiteModel } from "../scene/siteModel";
import { Trees } from "../scene/Trees";
import type { SceneryAssets } from "./assets";
import { CoverTrees } from "./CoverTrees";
import { Houses } from "./Houses";
import { reportPerf } from "./Perf";
import { Places } from "./Places";

export function Scenery({ stationId, assets, model }: { stationId: string; assets: SceneryAssets; model: SiteModel }) {
  const climate = assets.road.climate;
  const lat = assets.road.origin.lat;
  if (!assets.cover) return <Trees seed={stationId} climate={climate} lat={lat} model={model} />;
  return (
    <>
      <CoverTrees seed={stationId} climate={climate} lat={lat} model={model} cover={assets.cover} />
      <Houses seed={stationId} model={model} cover={assets.cover} />
      <Places places={assets.places} model={model} />
      <PerfProbe />
    </>
  );
}

/** Samples the renderer once a second for the ?perf readout (a no-op without the readout on the page). Reads
 *  after each render, since three.js resets its counters when the next one starts. */
function PerfProbe() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    let frames = 0;
    let since = performance.now();
    return addAfterEffect(() => {
      frames++;
      const now = performance.now();
      if (now - since < 1000) return;
      reportPerf({ fps: (frames * 1000) / (now - since), calls: gl.info.render.calls, triangles: gl.info.render.triangles });
      frames = 0;
      since = now;
    });
  }, [gl]);
  return null;
}
