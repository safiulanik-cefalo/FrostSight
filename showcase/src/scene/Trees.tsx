import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { PALETTE } from "./geometry";
import { treePlacements } from "./dressing";
import { SITE_SIZE } from "./scale";
import type { SiteModel } from "./siteModel";

const COUNT = 420;
const TREE_SCALE = 1.5;

export function Trees({ seed, climate, model }: { seed: string; climate: string; model: SiteModel }) {
  const crowns = useRef<THREE.InstancedMesh>(null);
  const trunks = useRef<THREE.InstancedMesh>(null);
  const trees = useMemo(
    () => treePlacements(seed, climate, model.groundM, model.distToRoad, SITE_SIZE * 0.96, COUNT),
    [seed, climate, model],
  );
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    trees.forEach((t, i) => {
      const y = model.ground(t.x, t.z);
      s.setScalar(t.s * TREE_SCALE);
      crowns.current?.setMatrixAt(i, m.compose(v.set(t.x, y + 2.5 * t.s * TREE_SCALE, t.z), q, s));
      trunks.current?.setMatrixAt(i, m.compose(v.set(t.x, y + 0.6 * t.s * TREE_SCALE, t.z), q, s));
    });
    for (const mesh of [crowns.current, trunks.current]) {
      if (!mesh) continue;
      mesh.count = trees.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }, [trees, model]);
  return (
    <group>
      <instancedMesh ref={crowns} args={[undefined, undefined, COUNT]} castShadow>
        <coneGeometry args={[1.15, 3.8, 6]} />
        <meshStandardMaterial color={PALETTE.tree} flatShading roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={trunks} args={[undefined, undefined, COUNT]}>
        <cylinderGeometry args={[0.3, 0.4, 1.4, 5]} />
        <meshStandardMaterial color={PALETTE.trunk} roughness={1} />
      </instancedMesh>
    </group>
  );
}
