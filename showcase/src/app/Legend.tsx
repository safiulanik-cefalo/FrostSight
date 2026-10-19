import { useState } from "react";
import { LEVELS, levelLabel } from "../../shared/contract";

export const ATTRIBUTION =
  "Road data Statens vegvesen (NLOD). Weather MET Norway and Open-Meteo (CC BY 4.0). Elevation Mapzen terrain tiles.";
export const MAP_ATTRIBUTION =
  "Base map and place names Kartverket (CC BY 4.0). Road data Statens vegvesen (NLOD). Weather MET Norway and Open-Meteo (CC BY 4.0).";
const VAR: Record<string, string> = { LOW: "--low", MEDIUM: "--medium", HIGH: "--high", VERY_HIGH: "--very-high" };

export function Legend({ simulated, raised, onMap = false }: { simulated: boolean; raised: boolean; onMap?: boolean }) {
  const [credits, setCredits] = useState(false);
  const attribution = onMap ? MAP_ATTRIBUTION : ATTRIBUTION;
  return (
    <div className={`glass legend${raised ? " raised" : ""}${onMap ? " on-map" : ""}`} title={attribution}>
      {LEVELS.map((l) => (
        <span key={l}>
          <i style={{ background: `var(${VAR[l]})` }} />
          {levelLabel(l)}
        </span>
      ))}
      <span>
        <i style={{ background: "var(--none)" }} />
        {onMap ? "Station not reporting" : "No coverage"}
      </span>
      {onMap && (
        <span>
          <i className="incident" />
          Incident
        </span>
      )}
      {simulated && (
        <span>
          <i style={{ background: "var(--sim)" }} />
          Simulated
        </span>
      )}
      {!onMap && <span className="note">Cars are ambience, not traffic</span>}
      <button onClick={() => setCredits(!credits)} aria-expanded={credits}>
        Data sources
      </button>
      {onMap && <span className="note">© Kartverket</span>}
      {credits && <span className="attribution">{attribution}</span>}
    </div>
  );
}
