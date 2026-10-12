import { forwardRef } from "react";
import * as THREE from "three";

/** A low-poly car or truck, nose along +x. */
export const Car = forwardRef<THREE.Group, { color: string; length: number; truck?: boolean }>(function Car({ color, length, truck }, ref) {
  const box = (w: number, h: number, d: number, c: string, p: [number, number, number]) => (
    <mesh key={p.join(",")} position={p} castShadow>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={c} roughness={0.6} />
    </mesh>
  );
  const wheels: Array<[number, number]> = [
    [-length * 0.32, 0.9],
    [-length * 0.32, -0.9],
    [length * 0.32, 0.9],
    [length * 0.32, -0.9],
  ];
  return (
    <group ref={ref}>
      {truck ? (
        <>
          {box(length * 0.62, 2.1, 2.1, "#ffffff", [-length * 0.18, 1.55, 0])}
          {box(length * 0.32, 1.5, 2, color, [length * 0.32, 1.25, 0])}
          {box(length * 0.08, 0.5, 2.2, "#25304a", [length * 0.48, 0.7, 0])}
        </>
      ) : (
        <>
          {box(length, 1.1, 2, color, [0, 0.95, 0])}
          {box(length * 0.5, 0.8, 1.8, "#dfe8f6", [-0.1, 1.75, 0])}
        </>
      )}
      {wheels.map(([x, z]) => (
        <mesh key={`${x},${z}`} position={[x, 0.42, z]} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[0.42, 0.42, 0.3, 10]} />
          <meshStandardMaterial color="#25304a" />
        </mesh>
      ))}
    </group>
  );
});
