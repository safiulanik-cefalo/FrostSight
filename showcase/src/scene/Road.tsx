import { useMemo } from "react";
import * as THREE from "three";
import { ribbonGeometry, PALETTE } from "./geometry";
import { ROAD } from "./scale";
import type { SiteModel } from "./siteModel";

/** Road surface height by distance along the scaled road line (units), interpolated between road points. */
export function roadHeightFn(model: SiteModel) {
  const stepUnits = 25 * model.upm;
  return (_x: number, _z: number, s: number) => {
    const f = Math.max(0, Math.min(model.roadY.length - 1, s / stepUnits));
    const i = Math.min(model.roadY.length - 2, Math.floor(f));
    return model.roadY[i] * (1 - (f - i)) + model.roadY[i + 1] * (f - i);
  };
}

const DASH_EVERY_UNITS = 4;

export function Road({ model }: { model: SiteModel }) {
  const { shoulder, asphalt, dashes } = useMemo(() => {
    const h = roadHeightFn(model);
    const dashGeo = new THREE.BoxGeometry(1.6, 0.08, 0.24);
    const dashes: Array<{ x: number; y: number; z: number; r: number }> = [];
    for (let m = 40; m < model.lengthM; m += DASH_EVERY_UNITS / model.upm) {
      const p = model.at(m);
      dashes.push({ x: p.x, y: p.y + ROAD.lift + 0.08, z: p.z, r: Math.atan2(p.tx, p.tz) + Math.PI / 2 });
    }
    return {
      shoulder: ribbonGeometry(model.road, h, ROAD.shoulder, ROAD.lift - 0.08),
      asphalt: ribbonGeometry(model.road, h, ROAD.asphalt, ROAD.lift + 0.04),
      dashes: { geo: dashGeo, list: dashes },
    };
  }, [model]);
  return (
    <group>
      <mesh geometry={shoulder} receiveShadow>
        <meshStandardMaterial color={PALETTE.shoulder} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={asphalt} receiveShadow>
        <meshStandardMaterial color={PALETTE.asphalt} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
      {dashes.list.map((d, i) => (
        <mesh key={i} geometry={dashes.geo} position={[d.x, d.y, d.z]} rotation-y={d.r}>
          <meshStandardMaterial color={PALETTE.dash} />
        </mesh>
      ))}
    </group>
  );
}
