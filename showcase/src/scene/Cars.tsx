import { createRef, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { LevelOrNone } from "../../shared/contract";
import { advanceCar, carPlan, openRanges, placeCars, type CarSlot } from "../data/cars";
import type { Closure } from "../data/corridor";
import { Car } from "./Car";
import { ROAD, TIME_WARP } from "./scale";
import type { SiteModel } from "./siteModel";
import { Tag } from "./Tag";

const COLORS = ["#2f62e6", "#ffffff", "#56637d", "#c9d6ea"];
const LANE = 1.4;
const TRUCK_SPEED_MPS = 11;

type Mover = CarSlot & { ref: RefObject<THREE.Group | null>; speed: number; color: string; truck: boolean };

/** Ambience cars along the open road, and the gritting truck when the segment is high on the priority list. */
export function Cars({ model, level, closures, truck, reduced }: { model: SiteModel; level: LevelOrNone; closures: Closure[]; truck: boolean; reduced: boolean }) {
  const truckRef = useRef<THREE.Group>(null);
  const tagRef = useRef<THREE.Group>(null);
  const movers = useMemo<Mover[]>(() => {
    const plan = carPlan(level);
    const ranges = openRanges(model.lengthM, closures);
    const cars = placeCars(plan.count, ranges).map((c, i) => ({
      ...c,
      ref: createRef<THREE.Group>(),
      speed: plan.speed_mps * (0.85 + (i % 3) * 0.12),
      color: COLORS[i % COLORS.length],
      truck: false,
    }));
    const [t] = truck ? placeCars(1, ranges) : [];
    return t ? [...cars, { ...t, dir: -1 as const, pos: t.range[0] + (t.range[1] - t.range[0]) * 0.3, ref: truckRef, speed: TRUCK_SPEED_MPS, color: "#e28a2a", truck: true }] : cars;
  }, [model, level, closures, truck]);

  useFrame((_, dt) => {
    const step = reduced ? 0 : Math.min(dt, 0.05);
    for (const m of movers) {
      m.pos = advanceCar(m.pos, m.dir, m.speed * TIME_WARP, step, m.range);
      const p = model.at(m.pos);
      const g = m.ref.current;
      if (!g) continue;
      const off = m.dir * LANE;
      g.position.set(p.x - p.tz * off, p.y + ROAD.lift + 0.05, p.z + p.tx * off);
      g.rotation.y = Math.atan2(-p.tz * m.dir, p.tx * m.dir);
      if (m.truck && tagRef.current) tagRef.current.position.set(g.position.x, g.position.y + 4.2, g.position.z);
    }
  });

  return (
    <group>
      {movers.map((m, i) => (
        <Car key={i} ref={m.ref} color={m.color} length={m.truck ? 5.4 : 3.6} truck={m.truck} />
      ))}
      {truck && (
        <group ref={tagRef}>
          <Tag position={[0, 0, 0]} dot="#c98a12">
            GR-07 gritting
          </Tag>
        </group>
      )}
    </group>
  );
}
