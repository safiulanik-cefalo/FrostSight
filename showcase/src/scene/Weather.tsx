import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const AREA = 260;
const TOP = 70;

function flakeTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.5, "rgba(255,255,255,0.8)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/** Falling snow or rain over the plate, denser with the station's precipitation intensity. */
export function Weather({ precipType, mmH, reduced }: { precipType: string | null; mmH: number | null; reduced: boolean }) {
  const kind = /snow|sleet/i.test(precipType ?? "") ? "snow" : /rain|drizzle/i.test(precipType ?? "") ? "rain" : null;
  const intensity = Math.max(0.3, Math.min(2.5, (mmH ?? 1) / 2.4));
  const count = kind === "snow" ? Math.round(2600 * intensity) : kind === "rain" ? Math.round(1600 * intensity) : 0;
  const points = useRef<THREE.Points>(null);
  const { geometry, speeds, texture } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * AREA;
      pos[i * 3 + 1] = Math.random() * TOP;
      pos[i * 3 + 2] = (Math.random() - 0.5) * AREA;
      speeds[i] = kind === "rain" ? 40 + Math.random() * 20 : 5 + Math.random() * 7;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return { geometry, speeds, texture: flakeTexture() };
  }, [count, kind]);

  useFrame((state, dt) => {
    if (reduced || !points.current || count === 0) return;
    const a = geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    const t = state.clock.elapsedTime;
    const step = Math.min(dt, 0.05);
    for (let i = 0; i < count; i++) {
      arr[i * 3 + 1] -= speeds[i] * step;
      if (kind === "snow") arr[i * 3] += Math.sin(t + i) * 0.02;
      if (arr[i * 3 + 1] < 0) arr[i * 3 + 1] = TOP;
    }
    a.needsUpdate = true;
  });

  if (!kind) return null;
  return (
    <points ref={points} geometry={geometry}>
      <pointsMaterial
        map={texture}
        color={kind === "rain" ? "#c5d4ea" : "#ffffff"}
        size={kind === "rain" ? 0.7 : 1.6}
        transparent
        opacity={0.95}
        depthWrite={false}
        sizeAttenuation
      />
    </points>
  );
}
