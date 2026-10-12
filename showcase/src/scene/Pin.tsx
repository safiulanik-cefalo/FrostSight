import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { LEVEL_COLOR, levelLabel, type Level } from "../../shared/contract";
import { Tag } from "./Tag";

type Props = { position: [number, number, number]; scale?: number; name: string; level: Level | null; reporting: boolean; reduced: boolean; onSelect: () => void };

/** A station on the overview: a pin in its risk colour, a pulsing ring while it reports, a tag on hover. */
export function Pin({ position, scale = 1, name, level, reporting, reduced, onSelect }: Props) {
  const ring = useRef<THREE.Mesh>(null);
  const [hover, setHover] = useState(false);
  const color = LEVEL_COLOR[level ?? "NONE"];
  useFrame((state) => {
    if (!ring.current) return;
    const t = reduced || !reporting ? 0.5 : (state.clock.elapsedTime * 0.6 + position[0] * 0.01) % 1;
    ring.current.scale.setScalar(1 + t * 2.2);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = reporting ? 0.55 * (1 - t) : 0;
  });
  return (
    <group
      position={position}
      scale={scale}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = "";
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.3}>
        <ringGeometry args={[3, 3.8, 32]} />
        <meshBasicMaterial color={color} transparent depthWrite={false} />
      </mesh>
      <mesh position-y={1.5} castShadow>
        <cylinderGeometry args={[0.5, 0.5, 3, 8]} />
        <meshStandardMaterial color="#cfd6e2" />
      </mesh>
      <mesh position-y={6} castShadow scale={hover ? 1.25 : 1}>
        <sphereGeometry args={[2.6, 20, 14]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh position-y={3.4} rotation-x={Math.PI} scale={hover ? 1.25 : 1}>
        <coneGeometry args={[2.1, 3.4, 20]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {hover && (
        <Tag position={[0, 13, 0]} dot={color}>
          {name} · {levelLabel(level)}
          {!reporting && <span className="tag3-muted">stale</span>}
        </Tag>
      )}
    </group>
  );
}
