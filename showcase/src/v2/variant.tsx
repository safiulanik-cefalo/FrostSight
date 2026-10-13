// The /v2/ site variant: land cover paints the ground, trees follow the forest and its species, toy houses
// fill built-up land and place names label the map. A site without baked cover falls back to the base trees.
import { addAfterEffect, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import type * as THREE from "three";
import { BASE_SITE, type SceneryProps, type SiteVariant } from "../scene/Site";
import type { SiteAssets } from "../data/assets";
import type { SiteModel } from "../scene/siteModel";
import { hasPlaces, loadPlacesAssets } from "./assets";
import { applyCover } from "./scenery";
import { Houses } from "./Houses";
import { reportPerf } from "./Perf";
import { Places } from "./Places";
import { CoverTrees } from "./CoverTrees";

export const PLACES_ATTRIBUTION = "Land cover NIBIO AR5 (CC BY 4.0). Place names Kartverket (CC BY 4.0).";

function paintGround(g: THREE.BufferGeometry, assets: SiteAssets, model: SiteModel, snowline: boolean): void {
  if (hasPlaces(assets) && assets.cover) applyCover(g, assets.cover, model.upm, snowline);
}

function PlacesScenery(props: SceneryProps) {
  const { stationId, assets, model } = props;
  if (!hasPlaces(assets) || !assets.cover) return <BASE_SITE.Scenery {...props} />;
  return (
    <>
      <CoverTrees seed={stationId} climate={assets.road.climate} lat={assets.road.origin.lat} model={model} cover={assets.cover} />
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

export const PLACES_SITE: SiteVariant = { load: (id) => loadPlacesAssets(id), paintGround, Scenery: PlacesScenery };
