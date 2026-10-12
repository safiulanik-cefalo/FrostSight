import { Canvas } from "@react-three/fiber";
import type { ReactNode } from "react";
import { PALETTE } from "./geometry";

export function SceneCanvas({ children, cold = false, wide = false }: { children: ReactNode; cold?: boolean; wide?: boolean }) {
  const sky = cold ? "#d6e1f1" : PALETTE.sky;
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ fov: 36, near: 1, far: 4000, position: [120, 120, 160] }} style={{ position: "fixed", inset: 0 }}>
      <color attach="background" args={[sky]} />
      <fog attach="fog" args={wide ? [sky, 900, 2400] : [sky, 260, 620]} />
      <hemisphereLight args={["#f2f6ff", "#9fb3d4", 0.75]} />
      <directionalLight
        castShadow
        position={[-70, 120, 60]}
        intensity={1.5}
        color="#fff4e6"
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-170}
        shadow-camera-right={170}
        shadow-camera-top={170}
        shadow-camera-bottom={-170}
        shadow-camera-near={10}
        shadow-camera-far={500}
        shadow-bias={-0.0006}
      />
      {children}
    </Canvas>
  );
}
