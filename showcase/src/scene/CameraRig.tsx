import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
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

const FLY_S = 1.2;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

type Props = { home: Pose; minDistance: number; maxDistance: number; flyFrom?: Pose; reduced?: boolean };

/** Orbit controls with a home pose; on mount it flies from flyFrom to home unless motion is reduced. */
export function CameraRig({ home, minDistance, maxDistance, flyFrom, reduced = false }: Props) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const fly = useRef<{ t: number; from: THREE.Vector3; fromTarget: THREE.Vector3; to: THREE.Vector3; toTarget: THREE.Vector3 } | null>(null);

  useFrame((_, dt) => {
    const f = fly.current;
    const c = controls.current;
    if (!f || !c) return;
    f.t = Math.min(1, f.t + dt / FLY_S);
    const k = ease(f.t);
    camera.position.lerpVectors(f.from, f.to, k);
    c.target.lerpVectors(f.fromTarget, f.toTarget, k);
    c.update();
    if (f.t >= 1) fly.current = null;
  });

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
    if (flyFrom && !reduced) {
      const from = poseToPosition(flyFrom);
      camera.position.copy(from);
      c.target.set(...flyFrom.target);
      c.update();
      fly.current = { t: 0, from, fromTarget: new THREE.Vector3(...flyFrom.target), to: poseToPosition(home), toTarget: new THREE.Vector3(...home.target) };
    } else {
      goHome();
    }
    // flyFrom only matters on mount; a new object with the same pose must not restart the flight
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
