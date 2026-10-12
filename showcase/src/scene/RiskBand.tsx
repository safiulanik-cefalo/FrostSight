import { useMemo } from "react";
import * as THREE from "three";
import { LEVEL_COLOR } from "../../shared/contract";
import { ribbonGeometry } from "./geometry";
import { ROAD } from "./scale";
import { roadHeightFn } from "./Road";
import type { SiteModel } from "./siteModel";
import type { Stretch } from "../data/corridor";

/** The coloured band along both road edges, one strip per 2 km stretch, a small gap between stretches. */
export function RiskBand({ model, stretches }: { model: SiteModel; stretches: Stretch[] }) {
  const strips = useMemo(() => {
    const h = roadHeightFn(model);
    // road points are every 25 m, so metres along the road map linearly to units along the scaled line
    const metresToUnits = (m: number) => m * model.upm;
    return stretches.map((s) => ({
      s,
      geo: ribbonGeometry(model.road, h, ROAD.band, ROAD.lift - 0.02, metresToUnits(s.start_m + 40), metresToUnits(s.end_m - 40)),
    }));
  }, [model, stretches]);
  return (
    <group>
      {strips.map(({ s, geo }) => (
        <mesh key={`${s.start_m}-${s.level}-${s.closed}`} geometry={geo}>
          <meshStandardMaterial
            color={s.closed ? LEVEL_COLOR.HIGH : LEVEL_COLOR[s.level]}
            roughness={0.8}
            transparent={s.closed}
            opacity={s.closed ? 0.55 : 1}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
