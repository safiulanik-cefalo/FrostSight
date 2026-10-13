// SPIKE (throwaway): toy houses over the built-up cells, two instanced draws (walls and roofs).
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { SiteModel } from "../scene/siteModel";
import type { CoverGrid } from "./cover";
import { COVER_PALETTE, housePlacements } from "./dressingV2";

const CAP = 700;

export function Houses({ seed, model, cover }: { seed: string; model: SiteModel; cover: CoverGrid }) {
  const walls = useRef<THREE.InstancedMesh>(null);
  const roofs = useRef<THREE.InstancedMesh>(null);
  const houses = useMemo(() => housePlacements(seed, cover, model.upm, model.distToRoad, CAP), [seed, cover, model]);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    houses.forEach((h, i) => {
      const y = model.ground(h.x, h.z) - 0.15;
      q.setFromEuler(e.set(0, h.yaw, 0));
      walls.current?.setMatrixAt(i, m.compose(v.set(h.x, y + h.h / 2, h.z), q, s.set(h.w, h.h, h.d)));
      walls.current?.setColorAt(i, c.set(h.wall));
      const roofH = h.dense ? 0.25 : 0.7;
      roofs.current?.setMatrixAt(i, m.compose(v.set(h.x, y + h.h + roofH / 2, h.z), q, s.set(h.w * 1.08, roofH, h.d * 1.08)));
    });
    for (const mesh of [walls.current, roofs.current]) {
      if (!mesh) continue;
      mesh.count = houses.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [houses, model]);
  const roof = useMemo(() => {
    // a 4-sided cone turned 45 degrees is a pyramid on a unit square
    const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
    g.rotateY(Math.PI / 4);
    return g;
  }, []);
  return (
    <group>
      <instancedMesh ref={walls} args={[undefined, undefined, CAP]} castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" flatShading roughness={0.85} />
      </instancedMesh>
      <instancedMesh ref={roofs} args={[roof, undefined, CAP]} castShadow>
        <meshStandardMaterial color={COVER_PALETTE.roof} flatShading roughness={0.9} />
      </instancedMesh>
    </group>
  );
}
