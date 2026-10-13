import { LEVEL_COLOR } from "../../shared/contract";
import { Tag } from "./Tag";

const ORANGE = LEVEL_COLOR.HIGH;

/** A warning cone at an incident's own position; the one picked in the list is larger and labelled. */
export function IncidentMarker({ position, scale = 1, label, selected }: { position: [number, number, number]; scale?: number; label: string; selected: boolean }) {
  const s = scale * (selected ? 1.7 : 1);
  return (
    <group position={position}>
      <group scale={s}>
        <mesh position={[0, 1.4, 0]} castShadow>
          <coneGeometry args={[0.9, 2.8, 12]} />
          <meshStandardMaterial color={ORANGE} roughness={0.5} emissive={selected ? ORANGE : "#000000"} emissiveIntensity={selected ? 0.35 : 0} />
        </mesh>
        <mesh position={[0, 1.5, 0]}>
          <cylinderGeometry args={[0.5, 0.62, 0.45, 12]} />
          <meshStandardMaterial color="#ffffff" roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.08, 0]}>
          <boxGeometry args={[2, 0.16, 2]} />
          <meshStandardMaterial color="#2b2f38" roughness={0.8} />
        </mesh>
      </group>
      {selected && (
        <Tag position={[0, 3.6 * s + 1.5, 0]} tone="alert" dot={ORANGE}>
          {label}
        </Tag>
      )}
    </group>
  );
}
