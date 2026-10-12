import { useCurrentState, useShowcase } from "../data/store";
import { CameraControls } from "./CameraControls";
import { Header } from "./Header";
import { KpiCards } from "./KpiCards";
import { Legend } from "./Legend";

export function Hud() {
  const state = useCurrentState();
  const error = useShowcase((s) => s.error);
  return (
    <div className="hud">
      <Header />
      <KpiCards />
      <CameraControls />
      <Legend simulated={state?.source === "scenario"} />
      {!state && <div className={`boot${error ? " error" : ""}`}>{error ?? "Loading Troms…"}</div>}
    </div>
  );
}
