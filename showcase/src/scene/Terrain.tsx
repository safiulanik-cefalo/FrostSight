import { useMemo } from "react";
import * as THREE from "three";
import { terrainGeometry, PALETTE } from "./geometry";
import { SITE_EXAGGERATION, SITE_SIZE } from "./scale";
import type { SiteAssets } from "../data/assets";
import type { SiteModel } from "./siteModel";
import type { CoverGrid } from "../scenery/cover";
import { applyCover } from "../scenery/scenery";

/** The site's ground, with a road bed carved so the terrain never pokes through the road. */
export function Terrain({ assets, model, snowline, cover }: { assets: SiteAssets; model: SiteModel; snowline: boolean; cover: CoverGrid | null }) {
  const geometry = useMemo(() => {
    const { n } = assets.road.terrain;
    const g = terrainGeometry(assets.heights, n, SITE_SIZE, SITE_EXAGGERATION, model.upm, snowline);
    // land cover paints the ground before the road bed is carved
    if (cover) applyCover(g, cover, model.upm, snowline);
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
  }, [assets, model, snowline, cover]);
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
