import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

export type Pose = { target: [number, number, number]; azimuth: number; elevation: number; distance: number };

/** Called by the HUD's camera buttons; bound to the live controls once the canvas mounts. */
export const cameraActions = {
  zoomIn: () => {},
  zoomOut: () => {},
  rotate: () => {},
  home: () => {},
};

const MIN_ELEV = (12 * Math.PI) / 180;
const MAX_ELEV = (78 * Math.PI) / 180;

function poseToPosition(p: Pose): THREE.Vector3 {
  const [tx, ty, tz] = p.target;
  return new THREE.Vector3(
    tx + p.distance * Math.cos(p.elevation) * Math.sin(p.azimuth),
    ty + p.distance * Math.sin(p.elevation),
    tz + p.distance * Math.cos(p.elevation) * Math.cos(p.azimuth),
  );
}

export function CameraRig({ home, minDistance, maxDistance }: { home: Pose; minDistance: number; maxDistance: number }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const goHome = () => {
      camera.position.copy(poseToPosition(home));
      c.target.set(...home.target);
      c.update();
    };
    const dolly = (f: number) => {
      const off = camera.position.clone().sub(c.target).multiplyScalar(f);
      const len = THREE.MathUtils.clamp(off.length(), minDistance, maxDistance);
      camera.position.copy(c.target).add(off.setLength(len));
      c.update();
    };
    cameraActions.zoomIn = () => dolly(0.8);
    cameraActions.zoomOut = () => dolly(1.25);
    cameraActions.rotate = () => {
      const off = camera.position.clone().sub(c.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6);
      camera.position.copy(c.target).add(off);
      c.update();
    };
    cameraActions.home = goHome;
    goHome();
  }, [camera, home, minDistance, maxDistance]);

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={minDistance}
      maxDistance={maxDistance}
      minPolarAngle={Math.PI / 2 - MAX_ELEV}
      maxPolarAngle={Math.PI / 2 - MIN_ELEV}
    />
  );
}
