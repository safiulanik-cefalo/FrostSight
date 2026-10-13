// SPIKE (throwaway): v1 Terrain with the generic ground recoloured from the cover grid.
import { useMemo } from "react";
import * as THREE from "three";
import { terrainGeometry, PALETTE } from "../scene/geometry";
import { SITE_EXAGGERATION, SITE_SIZE } from "../scene/scale";
import type { SiteModel } from "../scene/siteModel";
import type { SiteAssetsV2 } from "./assets";
import { applyCover } from "./dressingV2";

export function TerrainV2({ assets, model, snowline }: { assets: SiteAssetsV2; model: SiteModel; snowline: boolean }) {
  const geometry = useMemo(() => {
    const { n } = assets.road.terrain;
    const g = terrainGeometry(assets.heights, n, SITE_SIZE, SITE_EXAGGERATION, model.upm, snowline);
    if (assets.cover) applyCover(g, assets.cover, model.upm, snowline);
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const R = 9;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      let best = Infinity;
      let y = 0;
      for (let i = 0; i < model.road.length; i += 2) {
        const d = (model.road[i][0] - x) ** 2 + (model.road[i][1] - z) ** 2;
        if (d < best) {
          best = d;
          y = model.roadY[i];
        }
      }
      const d = Math.sqrt(best);
      if (d < R) {
        const t = (d / R) ** 2;
        pos.setY(v, Math.min(pos.getY(v), y * (1 - t) + pos.getY(v) * t) - (1 - t) * 0.3);
      }
    }
    g.computeVertexNormals();
    return g;
  }, [assets, model, snowline]);
  const seaY = (0 - model.minM) * SITE_EXAGGERATION * model.upm;
  return (
    <group>
      <mesh geometry={geometry} receiveShadow castShadow>
        <meshStandardMaterial vertexColors flatShading roughness={0.95} metalness={0} />
      </mesh>
      {model.minM <= 1 && (
        <mesh rotation-x={-Math.PI / 2} position-y={seaY + 0.15} receiveShadow>
          <planeGeometry args={[SITE_SIZE, SITE_SIZE]} />
          <meshStandardMaterial color={PALETTE.water} roughness={0.4} />
        </mesh>
      )}
    </group>
  );
}
