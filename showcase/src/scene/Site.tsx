import { useEffect, useMemo, useState } from "react";
import { loadSiteAssets, type SiteAssets } from "../data/assets";
import { stretches as cutStretches, type Closure } from "../data/corridor";
import type { ScenarioClosure } from "../data/scenario";
import { useCurrentState, useShowcase } from "../data/store";
import { usePrefersReducedMotion } from "../hooks";
import { Barrier } from "./Barrier";
import { Cars } from "./Cars";
import { CameraRig, type Pose } from "./CameraRig";
import { nearestAlong, projectLocal } from "../data/geo";
import { closureLabel, isClosureIncident, isSimulatedIncident, liveClosure } from "./dressing";
import { IncidentMarker } from "./IncidentMarker";
import { incidentLabel } from "../app/listRows";
import { RiskBand } from "./RiskBand";
import { Road } from "./Road";
import { ROAD, SITE_SIZE, siteUnitsPerMetre } from "./scale";
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
    loadSiteAssets(stationId)
      .then((a) => live && setAssets(a))
      .catch((e: Error) => live && useShowcase.setState({ error: `${e.message}. Pick a station from the list.` }));
    return () => {
      live = false;
    };
  }, [stationId]);
  return assets;
}


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

  const incidentId = useShowcase((s) => s.incidentId);
  // live incidents with a position, in this site's local metres and placed on the road where it is near
  const located = useMemo(() => {
    if (!assets) return [];
    const now = Date.now();
    return (state?.incidents ?? [])
      .filter((i) => i.lat != null && i.lon != null && !isSimulatedIncident(i.incident_id))
      .filter((i) => !i.end_time || new Date(i.end_time).getTime() > now || i.incident_id === incidentId)
      .map((i) => {
        const [x, z] = projectLocal(i.lat!, i.lon!, assets.road.origin);
        return { incident: i, x, z, spot: nearestAlong(assets.road.points, x, z) };
      })
      .filter((p) => Math.abs(p.x) <= assets.road.terrain.size_m / 2 && Math.abs(p.z) <= assets.road.terrain.size_m / 2);
  }, [assets, state?.incidents, incidentId]);

  // Live closures: an active closure incident at this station, around its own spot on the road when it has a
  // position, else 1 km either side of the station and marked approximate. Scenario closures carry a stretch.
  const closuresRaw = useMemo<Closure[]>(() => {
    if (!model) return [];
    const segId = station?.road_segment_id;
    const now = Date.now();
    const live = (state?.incidents ?? [])
      // sim- incidents come from a scenario, whose closures carry their own stretch below
      .filter((i) => !isSimulatedIncident(i.incident_id) && isClosureIncident(i.incident_type))
      .filter((i) => (i.station_id != null ? i.station_id === stationId : Boolean(segId) && i.road_segment_id === segId))
      .filter((i) => !i.end_time || new Date(i.end_time).getTime() > now)
      .map((i) => liveClosure(model.lengthM, model.stationAtM, located.find((p) => p.incident === i)?.spot ?? null));
    const sim = scenarioClosures
      .filter((c) => c.station_id === stationId)
      .map((c) => ({ start_m: c.start_m, end_m: Math.min(c.end_m, model.lengthM), simulated: true }));
    return [...live.slice(0, 1), ...sim];
  }, [model, state?.incidents, station?.road_segment_id, scenarioClosures, stationId, located]);
  // the scenario state is rebuilt every second; compare by content so cars and the band are not rebuilt with it
  const closuresKey = JSON.stringify(closuresRaw);
  const closures = useMemo(() => JSON.parse(closuresKey) as Closure[], [closuresKey]);

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
              label={j === 0 ? closureLabel(c, assets.road.name) : undefined}
              simulated={c.simulated}
            />
          );
        }),
      )}
      {located.map(({ incident, x, z }) => {
        const upm = siteUnitsPerMetre(assets.road.terrain.size_m);
        const sx2 = Math.max(-SITE_SIZE / 2, Math.min(SITE_SIZE / 2, x * upm));
        const sz2 = Math.max(-SITE_SIZE / 2, Math.min(SITE_SIZE / 2, z * upm));
        return (
          <IncidentMarker
            key={incident.incident_id}
            position={[sx2, model.ground(sx2, sz2) + ROAD.lift, sz2]}
            label={incidentLabel(incident.incident_type)}
            selected={incident.incident_id === incidentId}
          />
        );
      })}
      <Cars model={model} level={level ?? "NONE"} closures={closures} truck={(segment?.priority_rank ?? 99) <= 5} reduced={reduced} />
      <Weather precipType={segment?.readings.precip_type ?? null} mmH={segment?.readings.precip_mm_h ?? null} reduced={reduced} />
    </group>
  );
}
