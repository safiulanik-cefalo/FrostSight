import { useFrame } from "@react-three/fiber";
import { useShowcase } from "../data/store";

/** Advances the scenario clock with the render loop, so it pauses when the tab is hidden. */
export function ScenarioClock() {
  const tick = useShowcase((s) => s.tick);
  useFrame((_, dt) => tick(Math.min(dt, 0.1)));
  return null;
}
