import { useShowcase } from "../data/store";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Play, pause and scrub the running scenario. Everything it drives wears "Simulated". */
export function ScenarioBar() {
  const scenario = useShowcase((s) => s.scenario);
  const clockS = useShowcase((s) => s.clockS);
  const playing = useShowcase((s) => s.playing);
  const togglePlay = useShowcase((s) => s.togglePlay);
  const seek = useShowcase((s) => s.seek);
  const setScenario = useShowcase((s) => s.setScenario);
  if (!scenario) return null;
  return (
    <div className="glass scenario-bar" role="group" aria-label="Scenario player">
      <span className="pill sim sm">Simulated</span>
      <b>{scenario.title}</b>
      <button className="play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <input
        id="scenario-clock"
        type="range"
        min={0}
        max={scenario.duration_s}
        step={0.5}
        value={clockS}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Scenario time"
      />
      <span className="time">
        {mmss(clockS)} / {mmss(scenario.duration_s)}
      </span>
      <button className="close" onClick={() => setScenario(null)} aria-label="Stop the scenario">
        ×
      </button>
    </div>
  );
}
