// SPIKE (throwaway): place-name labels as map lettering, by tier: towns, bridges, islands always; peaks and
// valleys when the camera is nearer; rivers and capes only close up.
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useState } from "react";
import { SITE_EXAGGERATION } from "../scene/scale";
import type { SiteModel } from "../scene/siteModel";
import type { Place } from "./assets";

const SEA_KINDS = new Set(["fjord", "sound"]);
/** Scene units above the ground; towns float high so the bridge or district at the same spot stays readable. */
const LIFT: Partial<Record<Place["kind"], number>> = { town: 9, island: 6, district: 3, bridge: 1, tunnel: 1 };

function tierFor(distance: number): 1 | 2 | 3 {
  return distance > 300 ? 1 : distance > 170 ? 2 : 3;
}

export function Places({ places, model }: { places: Place[]; model: SiteModel }) {
  const camera = useThree((s) => s.camera);
  const [shown, setShown] = useState<1 | 2 | 3>(1);
  useFrame(() => {
    const t = tierFor(camera.position.length());
    if (t !== shown) setShown(t);
  });
  const seaY = (0 - model.minM) * SITE_EXAGGERATION * model.upm;
  return (
    <group>
      {places
        .filter((p) => p.tier <= shown)
        .map((p) => {
          const x = p.xz[0] * model.upm;
          const z = p.xz[1] * model.upm;
          const y = (SEA_KINDS.has(p.kind) ? seaY : model.ground(x, z)) + (LIFT[p.kind] ?? 2);
          return (
            <Html key={`${p.kind}:${p.name}`} position={[x, y, z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
              <span className={`place place-${p.kind}`}>{p.name}</span>
            </Html>
          );
        })}
    </group>
  );
}
