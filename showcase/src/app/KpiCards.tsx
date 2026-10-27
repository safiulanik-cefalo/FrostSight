import { ageLabel, dataAgeMinutes } from "../../shared/contract";
import { useCurrentState, useShowcase } from "../data/store";
import { regionKpi } from "../data/regions";
import { kpiNarrow } from "./format";
import { useRegion } from "./useRegion";
import { Icon } from "./icons";
import { useSites } from "./useSites";

export function KpiCards({ onMap = false }: { onMap?: boolean } = {}) {
  const state = useCurrentState();
  const siteId = useShowcase((s) => s.siteId);
  const bakedRoad = useSites().find((s) => s.station_id === siteId)?.road;
  const region = useRegion();
  if (!state) return null;
  // the region's counters, counted from its rows; the whole document's before the regions have loaded
  const kpi = region ? regionKpi(state, region, new Date()) : state.kpi;
  const where = region?.name ?? "All counties";
  const narrow = siteId ? kpiNarrow(state, siteId, bakedRoad) : null;
  const at = state.gold.risk_updated_at ?? state.generated_at;
  const age = Math.max(0, dataAgeMinutes(at, new Date()));
  const ageText = ageLabel(age).replace(" old", "");
  const [ageNum, ageUnit] = /\d/.test(ageText) ? ageText.split(" ") : [ageText, ""];
  return (
    <div className={`kpis${onMap ? " on-map" : ""}`}>
      <div className="glass kpi">
        <div className="ic alert"><Icon.Alert /></div>
        <div>
          <div className="lab">Segments at HIGH or above</div>
          <div className="val">{narrow ? narrow.high : kpi.segments_high} <small>of {narrow ? narrow.total : kpi.segments_total}</small></div>
          <div className="sub">{narrow ? `on ${narrow.road}` : `${where} · ${kpi.segments_very_high} very high`}</div>
        </div>
      </div>
      <div className="glass kpi">
        <div className="ic"><Icon.Mast /></div>
        <div>
          <div className="lab">Stations reporting</div>
          <div className="val">{kpi.stations_reporting} <small>of {kpi.stations_total}</small></div>
          <div className="sub">{where}</div>
        </div>
      </div>
      <div className="glass kpi">
        <div className="ic"><Icon.Clock /></div>
        <div>
          <div className="lab">Data age</div>
          <div className="val">{ageNum} <small>{ageUnit}</small></div>
          <div className="sub">gold rebuilt {new Date(at).toISOString().slice(11, 16)} UTC</div>
        </div>
      </div>
    </div>
  );
}
