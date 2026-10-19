// Generic toy landmarks under the landmark labels, so people who know a place can find its church or hospital.
// The bake names each one's model from its Kartverket type (tools/bake_places.py, LANDMARK_MODELS).
import { useMemo, type ReactElement } from "react";
import * as THREE from "three";
import type { SiteModel } from "../scene/siteModel";
import type { LandmarkModel, Place } from "./assets";
import { placeLandmarks } from "./landmarkPlacement";

const WHITE = "#f4f1ea";
const ROOF = "#4a4f5c";
const PALE = "#e8ecf2";
const CROSS = "#d8443a";

/** A white nave with a pitched roof, and a tower with a spire at the west end. */
function Church() {
  const roof = useMemo(() => {
    const g = new THREE.CylinderGeometry(1.25, 1.25, 4.6, 3, 1);
    g.rotateZ(Math.PI / 2);
    g.rotateY(Math.PI / 2);
    return g;
  }, []);
  return (
    <group>
      <mesh position={[0, 1.1, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.2, 2.2, 4.4]} />
        <meshStandardMaterial color={WHITE} flatShading />
      </mesh>
      <mesh geometry={roof} position={[0, 2.55, 0]} castShadow>
        <meshStandardMaterial color={ROOF} flatShading />
      </mesh>
      <mesh position={[0, 2.2, -2.7]} castShadow>
        <boxGeometry args={[1.3, 4.4, 1.3]} />
        <meshStandardMaterial color={WHITE} flatShading />
      </mesh>
      <mesh position={[0, 5.7, -2.7]} castShadow>
        <coneGeometry args={[0.95, 2.6, 4]} />
        <meshStandardMaterial color={ROOF} flatShading />
      </mesh>
    </group>
  );
}

/** A large pale block with a red cross on the roof. */
function Hospital() {
  return (
    <group>
      <mesh position={[0, 1.8, 0]} castShadow receiveShadow>
        <boxGeometry args={[7, 3.6, 4.2]} />
        <meshStandardMaterial color={PALE} flatShading />
      </mesh>
      <mesh position={[2.6, 2.6, 2.6]} castShadow receiveShadow>
        <boxGeometry args={[2.4, 5.2, 2.4]} />
        <meshStandardMaterial color={PALE} flatShading />
      </mesh>
      <mesh position={[-1, 3.65, 0]}>
        <boxGeometry args={[2.4, 0.12, 0.7]} />
        <meshStandardMaterial color={CROSS} />
      </mesh>
      <mesh position={[-1, 3.65, 0]}>
        <boxGeometry args={[0.7, 0.12, 2.4]} />
        <meshStandardMaterial color={CROSS} />
      </mesh>
    </group>
  );
}

/** Three long flat-roofed blocks around a yard. */
function Campus() {
  const blocks: Array<[number, number, number, number]> = [
    [0, -2.4, 7, 1.8],
    [-2.6, 0.6, 1.8, 4.2],
    [2.6, 0.6, 1.8, 4.2],
  ];
  return (
    <group>
      {blocks.map(([x, z, w, d], i) => (
        <mesh key={i} position={[x, 1.4, z]} castShadow receiveShadow>
          <boxGeometry args={[w, 2.8, d]} />
          <meshStandardMaterial color={i === 0 ? "#c9a27a" : PALE} flatShading />
        </mesh>
      ))}
    </group>
  );
}

const MODEL: Record<LandmarkModel, () => ReactElement> = { church: Church, hospital: Hospital, campus: Campus };

export function Landmarks({ places, model, half }: { places: Place[]; model: SiteModel; half: number }) {
  const items = useMemo(() => placeLandmarks(places, model, half), [places, model, half]);
  return (
    <group>
      {items.map(({ key, model: kind, x, y, z, yaw }) => {
        const Model = MODEL[kind];
        return (
          <group key={key} position={[x, y, z]} rotation-y={yaw}>
            <Model />
          </group>
        );
      })}
    </group>
  );
}
