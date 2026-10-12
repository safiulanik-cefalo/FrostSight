import { useMemo } from "react";
import { useCurrentState, useShowcase } from "../data/store";
import { outlookSteps } from "../data/outlook";
import { Icon } from "./icons";
import { levelClass } from "./Pill";
import { levelLabel } from "../../shared/contract";

export function Outlook() {
  const state = useCurrentState();
  const siteId = useShowcase((s) => s.siteId);
  const segmentId = useShowcase((s) => s.segmentId);
  const scenario = useShowcase((s) => s.scenario);
  const segment = state?.segments.find((s) => s.road_segment_id === segmentId) ?? state?.segments.find((s) => s.station_id === siteId) ?? null;
  const name = segment ? state?.stations.find((s) => s.station_id === segment.station_id)?.name ?? segment.segment : null;
  const steps = useMemo(() => {
    if (!state || !segment) return [];
    const history = state.history[segment.road_segment_id] ?? [];
    return outlookSteps(history, new Date(), scenario?.outlook ?? [], { level: segment.risk_level, score: segment.icing_score });
  }, [state, segment, scenario]);
  if (!siteId || !state) return null;
  return (
    <section className="glass timeline" aria-label="Risk outlook">
      <div className="hd">
        <Icon.Trend />
        Risk outlook{segment ? ` · ${segment.road} ${name}` : ""}
        <small>{scenario ? "simulated history and outlook" : "last 24 h from gold · no forecast yet"}</small>
      </div>
      {steps.length === 0 ? (
        <p className="empty">No readings in the last 24 h.</p>
      ) : (
        <div className="steps">
          {steps.map((s) => (
            <div key={s.label} className={`step ${levelClass(s.level)}${s.label === "Now" ? " now" : ""}${s.simulated ? " sim" : ""}`}>
              <div className="n">{s.level[0]}</div>
              <b>{s.label}</b>
              <small>
                {levelLabel(s.level)} · {s.score.toFixed(2)}
              </small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
