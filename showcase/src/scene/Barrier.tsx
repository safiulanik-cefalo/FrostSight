import { LEVEL_COLOR } from "../../shared/contract";
import { Tag } from "./Tag";

const RED = LEVEL_COLOR.HIGH;

/** A closure barrier across the road: two posts, a striped bar and a sign. */
export function Barrier({ x, y, z, angle, label, simulated }: { x: number; y: number; z: number; angle: number; label?: string; simulated: boolean }) {
  const part = (w: number, h: number, d: number, color: string, p: [number, number, number]) => (
    <mesh key={p.join(",")} position={p} castShadow>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={color} roughness={0.6} />
    </mesh>
  );
  return (
    <group position={[x, y, z]}>
      <group rotation-y={angle}>
        {part(0.4, 1.6, 0.4, RED, [-3.6, 0.8, 0])}
        {part(0.4, 1.6, 0.4, RED, [3.6, 0.8, 0])}
        {[-3, -2, -1, 0, 1, 2, 3].map((i) => part(1, 0.3, 0.25, i % 2 ? RED : "#ffffff", [i, 1.4, 0]))}
        {part(2.2, 1.4, 0.15, "#ffffff", [0, 2.6, 0])}
        {part(1.6, 0.9, 0.1, RED, [0, 2.6, 0.1])}
      </group>
      {label && (
        <Tag position={[0, 5.5, 0]} tone="alert" dot={RED}>
          {label}
          {simulated && <em>Simulated</em>}
        </Tag>
      )}
    </group>
  );
}
