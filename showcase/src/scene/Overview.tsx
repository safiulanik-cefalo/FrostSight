import { useEffect, useMemo, useState } from "react";
import { Line } from "@react-three/drei";
import { loadOverviewAssets, type OverviewAssets } from "../data/assets";
import { useCurrentState, useShowcase } from "../data/store";
import { usePrefersReducedMotion } from "../hooks";
import { CameraRig, type Pose } from "./CameraRig";
import { heightAt, PALETTE, terrainGeometry } from "./geometry";
import { Pin } from "./Pin";

/** The county overview plate: units per metre and vertical exaggeration for a 295 km square. */
export const OVERVIEW_SIZE = 600;
const EXAGGERATION = 7;

export function Overview() {
  const [assets, setAssets] = useState<OverviewAssets | null>(null);
  const state = useCurrentState();
  const goSite = useShowcase((s) => s.goSite);
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    loadOverviewAssets().then(setAssets);
  }, []);

  const scene = useMemo(() => {
    if (!assets) return null;
    const { n, size_m } = assets.county.terrain;
    const upm = OVERVIEW_SIZE / size_m;
    const y = (x: number, z: number) => Math.max(0, heightAt(assets.heights, n, size_m, x / upm, z / upm)) * EXAGGERATION * upm;
    const lift = (pts: [number, number][], dy: number) => pts.map(([x, z]) => [x * upm, y(x * upm, z * upm) + dy, z * upm] as [number, number, number]);
    return {
      upm,
      y,
      terrain: terrainGeometry(assets.heights, n, OVERVIEW_SIZE, EXAGGERATION, upm, true),
      border: assets.county.rings.map((r) => lift(r, 0.6)),
      roads: assets.roads.map((r) => lift(r.points, 0.8)),
    };
  }, [assets]);

  const home = useMemo<Pose>(() => ({ target: [0, 0, 20], azimuth: 0.2, elevation: 0.98, distance: 760 }), []);
  if (!assets || !scene) return null;
  return (
    <group>
      <CameraRig home={home} minDistance={120} maxDistance={1100} reduced={reduced} flyFrom={{ ...home, distance: 360, elevation: 0.7 }} />
      <mesh geometry={scene.terrain} receiveShadow>
        <meshStandardMaterial vertexColors flatShading roughness={0.95} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.2}>
        <planeGeometry args={[OVERVIEW_SIZE * 3, OVERVIEW_SIZE * 3]} />
        <meshStandardMaterial color="#c3d6ee" roughness={0.9} />
      </mesh>
      {scene.border.map((pts, i) => (
        <Line key={`b${i}`} points={pts} color={PALETTE.accent} lineWidth={1.5} dashed dashSize={4} gapSize={3} transparent opacity={0.7} />
      ))}
      {scene.roads.map((pts, i) => (
        <Line key={`r${i}`} points={pts} color={PALETTE.asphalt} lineWidth={1.6} />
      ))}
      {assets.stations.map((s) => {
        const live = state?.stations.find((x) => x.station_id === s.station_id);
        const x = s.xz[0] * scene.upm;
        const z = s.xz[1] * scene.upm;
        return (
          <Pin
            key={s.station_id}
            position={[x, scene.y(x, z), z]}
            scale={1.6}
            name={s.name}
            level={live?.risk_level ?? null}
            reporting={live?.status === "Reporting"}
            reduced={reduced}
            onSelect={() => goSite(s.station_id)}
          />
        );
      })}
    </group>
  );
}
