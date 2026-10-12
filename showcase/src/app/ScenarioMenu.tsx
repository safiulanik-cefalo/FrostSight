import { useEffect, useState } from "react";
import { parseScenario } from "../data/scenario";
import { useShowcase } from "../data/store";

type Entry = { id: string; title: string; blurb: string };

/** The header's scenario switch: off shows live data; on opens the list of scripted scenarios. */
export function ScenarioMenu() {
  const scenario = useShowcase((s) => s.scenario);
  const setScenario = useShowcase((s) => s.setScenario);
  const goSite = useShowcase((s) => s.goSite);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/scenarios/index.json")
      .then((r) => r.json() as Promise<Entry[]>)
      .then(setEntries)
      .catch(() => setError("Scenarios could not be loaded."));
  }, []);
  const start = async (id: string) => {
    try {
      const s = parseScenario(await (await fetch(`/scenarios/${id}.json`)).json());
      setScenario(s);
      if (s.focus_station_id) goSite(s.focus_station_id);
      setOpen(false);
    } catch {
      setError(`Scenario “${id}” is not valid.`);
    }
  };
  return (
    <div className="switcher" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <button
        className="chip scenario-btn"
        aria-pressed={Boolean(scenario)}
        onClick={() => (scenario ? setScenario(null) : setOpen(!open))}
        title={scenario ? "Stop the scenario and show live data" : "Play a scripted scenario"}
      >
        <span className="sw" />
        {scenario ? "Scenario on" : "Scenarios"}
      </button>
      {open && (
        <div className="menu glass scenario-menu" role="listbox">
          {error && <div className="menu-empty">{error}</div>}
          {entries.map((e) => (
            <button key={e.id} className="menu-item scenario-item" onClick={() => start(e.id)}>
              <span />
              <span>
                <b>{e.title}</b>
                <small>{e.blurb}</small>
              </span>
              <span />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
