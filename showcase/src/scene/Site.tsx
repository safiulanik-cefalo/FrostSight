import { useEffect, useMemo, useState } from "react";
import { loadSiteAssets, type SiteAssets } from "../data/assets";
import { stretches as cutStretches, type Closure } from "../data/corridor";
import { useCurrentState } from "../data/store";
import { CameraRig, type Pose } from "./CameraRig";
import { RiskBand } from "./RiskBand";
import { Road } from "./Road";
import { siteModel } from "./siteModel";
import { Terrain } from "./Terrain";

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

export function Site({ stationId, closures = [] }: { stationId: string; closures?: Closure[] }) {
  const assets = useSiteAssets(stationId);
  const state = useCurrentState();
  const model = useMemo(() => (assets ? siteModel(assets) : null), [assets]);
  const station = state?.stations.find((s) => s.station_id === stationId) ?? null;
  const segment = state?.segments.find((s) => s.station_id === stationId) ?? null;
  const level = segment?.risk_level ?? station?.risk_level ?? null;
  const surface = segment?.surface_c ?? segment?.air_c ?? null;
  const snowline = surface === null || surface <= 0.5;
  const closuresKey = JSON.stringify(closures);
  const strips = useMemo(
    () => (model ? cutStretches(model.lengthM, model.stationAtM, level, closures) : []),
    // closures compared by value so a new array with the same closures does not rebuild the band
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, level, closuresKey],
  );
  const home = useMemo<Pose | null>(() => {
    if (!model) return null;
    const mid = model.at(model.lengthM / 2);
    const st = model.at(model.stationAtM);
    return { target: [(mid.x + st.x) / 2, st.y, (mid.z + st.z) / 2], azimuth: 0.58, elevation: 0.6, distance: 200 };
  }, [model]);

  if (!assets || !model || !home) return null;
  return (
    <group>
      <CameraRig home={home} minDistance={40} maxDistance={420} />
      <Terrain assets={assets} model={model} snowline={snowline} />
      <Road model={model} />
      <RiskBand model={model} stretches={strips} />
    </group>
  );
}
