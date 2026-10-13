// SPIKE (throwaway): trees placed by the cover grid; conifers as cones, birch as low-poly round crowns.
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { PALETTE } from "../scene/geometry";
import { SITE_SIZE } from "../scene/scale";
import type { SiteModel } from "../scene/siteModel";
import type { CoverGrid } from "./cover";
import { COVER_PALETTE, treePlacementsV2 } from "./dressingV2";

const COUNT = 600;
const TREE_SCALE = 1.5;

export function TreesV2({ seed, climate, lat, model, cover }: { seed: string; climate: string; lat: number; model: SiteModel; cover: CoverGrid }) {
  const cones = useRef<THREE.InstancedMesh>(null);
  const crowns = useRef<THREE.InstancedMesh>(null);
  const trunks = useRef<THREE.InstancedMesh>(null);
  const trees = useMemo(
    () => treePlacementsV2(seed, climate, lat, cover, model.upm, model.groundM, model.distToRoad, SITE_SIZE * 0.96, COUNT),
    [seed, climate, lat, cover, model],
  );
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    let nc = 0;
    let nl = 0;
    trees.forEach((t, i) => {
      const y = model.ground(t.x, t.z);
      const k = t.s * TREE_SCALE;
      s.setScalar(k);
      if (t.kind === "conifer") cones.current?.setMatrixAt(nc++, m.compose(v.set(t.x, y + 2.5 * k, t.z), q, s));
      else crowns.current?.setMatrixAt(nl++, m.compose(v.set(t.x, y + 2.2 * k, t.z), q, s.setScalar(k * 0.9)));
      trunks.current?.setMatrixAt(i, m.compose(v.set(t.x, y + 0.6 * k, t.z), q, s.setScalar(k)));
    });
    for (const [mesh, n] of [[cones.current, nc], [crowns.current, nl], [trunks.current, trees.length]] as const) {
      if (!mesh) continue;
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }, [trees, model]);
  return (
    <group>
      <instancedMesh ref={cones} args={[undefined, undefined, COUNT]} castShadow>
        <coneGeometry args={[1.15, 3.8, 6]} />
        <meshStandardMaterial color={PALETTE.tree} flatShading roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={crowns} args={[undefined, undefined, COUNT]} castShadow>
        <icosahedronGeometry args={[1.5, 0]} />
        <meshStandardMaterial color={COVER_PALETTE.birch} flatShading roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={trunks} args={[undefined, undefined, COUNT]}>
        <cylinderGeometry args={[0.3, 0.4, 1.4, 5]} />
        <meshStandardMaterial color={PALETTE.trunk} roughness={1} />
      </instancedMesh>
    </group>
  );
}
