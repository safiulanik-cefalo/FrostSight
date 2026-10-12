import { useCurrentState, useShowcase } from "../data/store";
import { CameraControls } from "./CameraControls";
import { DetailPanel } from "./DetailPanel";
import { ListPanel } from "./ListPanel";
import { Outlook } from "./Outlook";
import { ScenarioBar } from "./ScenarioBar";
import { ScenarioMenu } from "./ScenarioMenu";
import { Header } from "./Header";
import { KpiCards } from "./KpiCards";
import { Legend } from "./Legend";

export function Hud() {
  const state = useCurrentState();
  const error = useShowcase((s) => s.error);
  const view = useShowcase((s) => s.view);
  return (
    <div className={`hud${state?.source === "scenario" ? " scenario-on" : ""}`}>
      <Header scenarioControl={<ScenarioMenu />} />
      <ScenarioBar />
      <KpiCards />
      <CameraControls />
      <DetailPanel />
      <Outlook />
      <ListPanel />
      <Legend simulated={state?.source === "scenario"} raised={view === "site"} />
      {!state && <div className={`boot${error ? " error" : ""}`}>{error ?? "Loading Troms…"}</div>}
    </div>
  );
}
