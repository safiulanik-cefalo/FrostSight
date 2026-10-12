import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { PALETTE } from "./geometry";
import { Tag } from "./Tag";
import { LEVEL_COLOR, levelLabel, type Level } from "../../shared/contract";

type Props = { position: [number, number, number]; name: string; reporting: boolean; windMs: number | null; level: Level | null; reduced: boolean };

/** Road weather station: cabinet, pole, mast with a spinning anemometer, and a pin that bobs while reporting. */
export function Station({ position, name, reporting, windMs, level, reduced }: Props) {
  const anemo = useRef<THREE.Group>(null);
  const pin = useRef<THREE.Group>(null);
  const pinColor = reporting ? PALETTE.accent : LEVEL_COLOR.NONE;
  useFrame((state, dt) => {
    if (reduced) return;
    if (anemo.current) anemo.current.rotation.y += dt * (0.6 + (windMs ?? 3) * 0.8);
    if (pin.current && reporting) pin.current.position.y = 12.5 + Math.sin(state.clock.elapsedTime * 3) * 0.5;
  });
  const box = (w: number, h: number, d: number, color: string, p: [number, number, number]) => (
    <mesh position={p} castShadow>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={color} roughness={0.7} />
    </mesh>
  );
  return (
    <group position={position}>
      {box(1.2, 1.2, 1.2, PALETTE.accent, [0, 0.6, 0])}
      {box(0.35, 9, 0.35, "#cfd6e2", [0, 4.5, 0])}
      {box(3.2, 0.18, 0.18, "#cfd6e2", [0, 8.6, 0])}
      {box(0.6, 0.5, 0.6, PALETTE.accent, [1.3, 8.9, 0])}
      {box(1.6, 0.9, 1.0, "#ffffff", [0, 6.2, 0])}
      <group ref={anemo} position={[-1.3, 8.9, 0]}>
        {[0, 1, 2].map((i) => {
          const a = (i * Math.PI * 2) / 3;
          return (
            <mesh key={i} position={[Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45]} rotation-y={-a}>
              <boxGeometry args={[0.9, 0.1, 0.1]} />
              <meshStandardMaterial color="#56637d" />
            </mesh>
          );
        })}
      </group>
      <group ref={pin} position={[0, 12.5, 0]}>
        <mesh>
          <sphereGeometry args={[1.1, 16, 12]} />
          <meshStandardMaterial color={pinColor} />
        </mesh>
        <mesh position={[0, -1.3, 0]} rotation-x={Math.PI}>
          <coneGeometry args={[0.9, 1.8, 16]} />
          <meshStandardMaterial color={pinColor} />
        </mesh>
      </group>
      <Tag position={[0, 16, 0]} dot={reporting ? LEVEL_COLOR.LOW : LEVEL_COLOR.NONE}>
        {name} station · {reporting ? "reporting" : "stale"}
        {level && <span className="tag3-level" style={{ color: LEVEL_COLOR[level] }}>{levelLabel(level)}</span>}
      </Tag>
    </group>
  );
}
