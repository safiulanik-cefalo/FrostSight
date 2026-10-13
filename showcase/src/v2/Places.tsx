// Place names as map lettering. Towns, bridges and islands show from afar, peaks and valleys nearer, rivers
// and capes close up; within that, labels that would collide on screen are hidden (labels.ts).
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { SITE_EXAGGERATION } from "../scene/scale";
import type { SiteModel } from "../scene/siteModel";
import type { Place, PlaceKind } from "./assets";
import { fitLabels, tierFor, type ScreenBox } from "./labels";

const ON_WATER = new Set<PlaceKind>(["fjord", "sound"]);
/** Scene units above the ground: a town floats above the bridge or district that shares its point. */
const LIFT: Partial<Record<PlaceKind, number>> = { town: 9, island: 6, district: 3, bridge: 1, tunnel: 1 };
/** The station's tag sits about here around the station's screen point; no label goes under it. */
const STATION_TAG: ScreenBox = { x: -150, y: -60, w: 300, h: 44 };

export function Places({ places, model }: { places: Place[]; model: SiteModel }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const positions = useMemo(() => {
    const seaY = (0 - model.minM) * SITE_EXAGGERATION * model.upm;
    return places.map((p) => {
      const x = p.xz[0] * model.upm;
      const z = p.xz[1] * model.upm;
      return new THREE.Vector3(x, (ON_WATER.has(p.kind) ? seaY : model.ground(x, z)) + (LIFT[p.kind] ?? 2), z);
    });
  }, [places, model]);
  const station = useMemo(() => {
    const s = model.at(model.stationAtM);
    return new THREE.Vector3(s.x, s.y, s.z);
  }, [model]);

  const [shown, setShown] = useState<number[]>([]);
  const last = useRef({ pose: "", key: "" });
  const v = useMemo(() => new THREE.Vector3(), []);
  // Refit whenever the camera or the canvas changed; fitting 45 labels is cheap next to a frame
  useFrame(() => {
    camera.updateMatrixWorld();
    const pose = `${camera.matrixWorld.elements.join(",")}|${size.width}x${size.height}`;
    if (pose === last.current.pose) return;
    last.current.pose = pose;
    const toScreen = (p: THREE.Vector3): [number, number] | null => {
      v.copy(p).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return null;
      return [((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height];
    };
    const st = toScreen(station);
    const reserved = st ? [{ ...STATION_TAG, x: st[0] + STATION_TAG.x, y: st[1] + STATION_TAG.y }] : [];
    const fit = fitLabels(places, positions.map(toScreen), tierFor(camera.position.distanceTo(station)), reserved);
    const key = fit.join(",");
    if (key !== last.current.key) {
      last.current.key = key;
      setShown(fit);
    }
  });

  return (
    <group>
      {shown.map((i) => (
        <Html key={`${places[i].kind}:${places[i].name}`} position={positions[i]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <span className={`place place-${places[i].kind}`}>{places[i].name}</span>
        </Html>
      ))}
    </group>
  );
}
