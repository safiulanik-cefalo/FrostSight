// SPIKE (throwaway): with ?perf in the URL, write fps, draw calls and triangles into #perf once a second.
import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";

export function Perf() {
  const gl = useThree((s) => s.gl);
  const frames = useRef(0);
  const since = useRef(performance.now());
  useFrame(() => {
    frames.current++;
    const now = performance.now();
    if (now - since.current < 1000) return;
    const fps = (frames.current * 1000) / (now - since.current);
    const el = document.getElementById("perf");
    if (el) el.textContent = `${fps.toFixed(0)} fps · ${gl.info.render.calls} draws · ${(gl.info.render.triangles / 1000).toFixed(0)}k tris`;
    frames.current = 0;
    since.current = now;
  });
  return null;
}
