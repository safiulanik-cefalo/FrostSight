import { Html } from "@react-three/drei";
import type { ReactNode } from "react";

export type TagTone = "neutral" | "alert" | "simulated" | "accent";

/** A small white chip floating above an object, in the HUD style. */
export function Tag({ position, tone = "neutral", dot, children }: { position: [number, number, number]; tone?: TagTone; dot?: string; children: ReactNode }) {
  return (
    <Html position={position} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
      <div className={`tag3 tag3-${tone}`}>
        {dot && <i style={{ background: dot }} />}
        {children}
      </div>
    </Html>
  );
}
