import { useEffect, useMemo, useState } from "react";
import { loadSiteAssets, type SiteAssets } from "../data/assets";
import { stretches as cutStretches, type Closure } from "../data/corridor";
import type { ScenarioClosure } from "../data/scenario";
import { useCurrentState } from "../data/store";
import { usePrefersReducedMotion } from "../hooks";
import { Barrier } from "./Barrier";
import { Cars } from "./Cars";
import { CameraRig, type Pose } from "./CameraRig";
import { isClosureIncident } from "./dressing";
import { RiskBand } from "./RiskBand";
import { Road } from "./Road";
import { ROAD } from "./scale";
import { siteModel } from "./siteModel";
import { Station } from "./Station";
import { Terrain } from "./Terrain";
import { Trees } from "./Trees";
import { Weather } from "./Weather";

export function useSiteAssets(stationId: string): SiteAssets | null {
  const [assets, setAssets] = useState<SiteAssets | null>(null);
  useEffect(() => {
    let live = true;
    setAssets(null);
    loadSiteAssets(stationId).then((a) => live && setAssets(a));
    return () => {
      live = false;
    };
  }, [stationId]);
  return assets;
}

const LIVE_CLOSURE_HALF_M = 1000;

export function Site({ stationId, scenarioClosures = [] }: { stationId: string; scenarioClosures?: ScenarioClosure[] }) {
  const assets = useSiteAssets(stationId);
  const state = useCurrentState();
  const reduced = usePrefersReducedMotion();
  const model = useMemo(() => (assets ? siteModel(assets) : null), [assets]);
  const station = state?.stations.find((s) => s.station_id === stationId) ?? null;
  const segment = state?.segments.find((s) => s.station_id === stationId) ?? null;
  const level = segment?.risk_level ?? station?.risk_level ?? null;
  const surface = segment?.surface_c ?? segment?.air_c ?? null;
  const snowline = surface === null || surface <= 0.5;

  // Live closures: an active closure incident on this station's segment, drawn 1 km either side of the
  // station because DATEX positions are not in the state. Scenario closures carry their own stretch.
  const closures = useMemo<Closure[]>(() => {
    if (!model) return [];
    const segId = station?.road_segment_id;
    const now = Date.now();
    const live = (state?.incidents ?? [])
      .filter((i) => segId && i.road_segment_id === segId && isClosureIncident(i.incident_type))
      .filter((i) => !i.end_time || new Date(i.end_time).getTime() > now)
      .map(() => ({
        start_m: Math.max(0, model.stationAtM - LIVE_CLOSURE_HALF_M),
        end_m: Math.min(model.lengthM, model.stationAtM + LIVE_CLOSURE_HALF_M),
        simulated: false,
      }));
    const sim = scenarioClosures
      .filter((c) => c.station_id === stationId)
      .map((c) => ({ start_m: c.start_m, end_m: Math.min(c.end_m, model.lengthM), simulated: true }));
    return [...live.slice(0, 1), ...sim];
  }, [model, state?.incidents, station?.road_segment_id, scenarioClosures, stationId]);

  const strips = useMemo(
    () => (model ? cutStretches(model.lengthM, model.stationAtM, level, closures) : []),
    [model, level, closures],
  );
  const home = useMemo<Pose | null>(() => {
    if (!model) return null;
    const mid = model.at(model.lengthM / 2);
    const st = model.at(model.stationAtM);
    return { target: [(mid.x + st.x) / 2, st.y, (mid.z + st.z) / 2], azimuth: 0.58, elevation: 0.6, distance: 200 };
  }, [model]);

  if (!assets || !model || !home) return null;
  const st = model.at(model.stationAtM);
  const sx = st.x - st.tz * 9;
  const sz = st.z + st.tx * 9;
  return (
    <group>
      <CameraRig
        home={home}
        minDistance={40}
        maxDistance={420}
        reduced={reduced}
        flyFrom={{ target: home.target, azimuth: home.azimuth - 0.7, elevation: 1.15, distance: 560 }}
      />
      <Terrain assets={assets} model={model} snowline={snowline} />
      <Road model={model} />
      <RiskBand model={model} stretches={strips} />
      <Trees seed={stationId} climate={assets.road.climate} model={model} />
      <Station
        position={[sx, model.ground(sx, sz), sz]}
        name={assets.road.name}
        reporting={station?.status === "Reporting"}
        windMs={segment?.readings.wind_ms ?? null}
        level={level}
        reduced={reduced}
      />
      {closures.flatMap((c, k) =>
        [c.start_m, c.end_m].map((m, j) => {
          const p = model.at(m);
          return (
            <Barrier
              key={`${k}-${j}`}
              x={p.x}
              y={p.y + ROAD.lift}
              z={p.z}
              angle={Math.atan2(p.tx, p.tz) + Math.PI / 2}
              label={j === 0 ? `Road closed · km ${(c.start_m / 1000).toFixed(0)} to ${(c.end_m / 1000).toFixed(0)}` : undefined}
              simulated={c.simulated}
            />
          );
        }),
      )}
      <Cars model={model} level={level ?? "NONE"} closures={closures} truck={(segment?.priority_rank ?? 99) <= 5} reduced={reduced} />
      <Weather precipType={segment?.readings.precip_type ?? null} mmH={segment?.readings.precip_mm_h ?? null} reduced={reduced} />
    </group>
  );
}
