import { useState } from "react";
import { LEVELS, levelLabel } from "../../shared/contract";

export const ATTRIBUTION =
  "Road data Statens vegvesen (NLOD). Weather MET Norway and Open-Meteo (CC BY 4.0). Elevation Mapzen terrain tiles.";
const VAR: Record<string, string> = { LOW: "--low", MEDIUM: "--medium", HIGH: "--high", VERY_HIGH: "--very-high" };

export function Legend({ simulated }: { simulated: boolean }) {
  const [credits, setCredits] = useState(false);
  return (
    <div className="glass legend" title={ATTRIBUTION}>
      {LEVELS.map((l) => (
        <span key={l}>
          <i style={{ background: `var(${VAR[l]})` }} />
          {levelLabel(l)}
        </span>
      ))}
      <span>
        <i style={{ background: "var(--none)" }} />
        No coverage
      </span>
      {simulated && (
        <span>
          <i style={{ background: "var(--sim)" }} />
          Simulated
        </span>
      )}
      <span className="note">Cars are ambience, not traffic</span>
      <button onClick={() => setCredits(!credits)} aria-expanded={credits}>
        Data sources
      </button>
      {credits && <span className="attribution">{ATTRIBUTION}</span>}
    </div>
  );
}
