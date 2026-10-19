// A frame-rate, draw-call and triangle readout for a site (?perf). The canvas writes into it through reportPerf
// (SiteScenery.tsx) once a second, straight to the DOM so the readout costs no React renders.
const ID = "perf";

export type PerfSample = { fps: number; calls: number; triangles: number };

export function reportPerf({ fps, calls, triangles }: PerfSample): void {
  const el = document.getElementById(ID);
  if (el) el.textContent = `${fps.toFixed(0)} fps · ${calls} draws · ${(triangles / 1000).toFixed(0)}k tris`;
}

export function Perf() {
  return <div id={ID} className="perf" />;
}
