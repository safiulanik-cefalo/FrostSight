import { useCurrentState, useShowcase, type Tab } from "../data/store";
import { Icon } from "./icons";
import { incidentRows, segmentRows, stationRows } from "./listRows";
import { LevelPill, ScoreBar, TonePill } from "./Pill";
import { useSites } from "./useSites";
import { useRegion } from "./useRegion";

export function ListPanel() {
  const state = useCurrentState();
  const siteId = useShowcase((s) => s.siteId);
  const tab = useShowcase((s) => s.tab);
  const setTab = useShowcase((s) => s.setTab);
  const select = useShowcase((s) => s.select);
  const goSite = useShowcase((s) => s.goSite);
  const focusIncident = useShowcase((s) => s.focusIncident);
  const incidentId = useShowcase((s) => s.incidentId);
  const bakedRoad = useSites().find((s) => s.station_id === siteId)?.road;
  const region = useRegion();
  if (!state) return null;
  const now = new Date();
  const segs = segmentRows(state, siteId, now, bakedRoad, region);
  const stations = stationRows(state, siteId, bakedRoad, region);
  const incidents = incidentRows(state, siteId, now, bakedRoad, region);
  const road = siteId ? state.stations.find((s) => s.station_id === siteId)?.road ?? bakedRoad : region?.name ?? "Troms";
  const tabs: Array<[Tab, string, string, boolean]> = [
    ["segments", "Segments", `${segs.filter((s) => s.level === "HIGH" || s.level === "VERY_HIGH").length}/${segs.length}`, false],
    ["stations", "Stations", `${stations.filter((s) => s.reporting).length}/${stations.length}`, false],
    ["incidents", "Incidents", `${incidents.filter((i) => i.active).length}`, incidents.some((i) => i.active)],
  ];
  return (
    <section className="glass list" aria-label="Lists">
      <div className="tabs" role="tablist">
        <span className="ic"><Icon.List /></span>
        {tabs.map(([id, label, count, alert]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
            {label} <span className={alert ? "alert" : ""}>{count}</span>
          </button>
        ))}
        <span className="where">{road}</span>
      </div>
      <div className="lrows">
        {tab === "segments" &&
          (segs.length === 0 ? (
            <p className="empty">No scored segments{siteId ? " on this road" : ""}.</p>
          ) : (
            segs.map((r) => (
              <button
                key={r.id}
                className="lrow"
                onClick={() => {
                  if (r.stationId && r.stationId !== siteId) goSite(r.stationId);
                  select(r.id);
                }}
              >
                <span className="n">
                  <i className={`d ${r.level.toLowerCase().replace("_", "-")}`} />
                  {r.title}
                  {r.closed && <em> · closed</em>}
                  <small>{r.subtitle}</small>
                </span>
                <LevelPill level={r.level} small />
                <ScoreBar score={r.score} level={r.level} />
                <span className="chev">›</span>
              </button>
            ))
          ))}
        {tab === "stations" &&
          stations.map((r) => (
            <button key={r.id} className="lrow" onClick={() => goSite(r.id)}>
              <span className="n">
                <i className={`d ${r.level.toLowerCase().replace("_", "-")}`} />
                {r.title}
                <small>{r.subtitle}</small>
              </span>
              <LevelPill level={r.level} small />
              <ScoreBar score={r.score} level={r.level} />
              <span className="chev">›</span>
            </button>
          ))}
        {tab === "incidents" &&
          (incidents.length === 0 ? (
            <p className="empty">No incidents{siteId ? " on this road" : ""} in the current feed.</p>
          ) : (
            incidents.map((r) => {
              const body = (
                <>
                  <span className="n">
                    <i className={`d ${r.active ? "high" : "none"}`} />
                    {r.title}
                    <small>{r.where ?? r.subtitle}</small>
                  </span>
                  <TonePill tone={r.active ? "high" : "none"}>{r.active ? "Active" : "Ended"}</TonePill>
                  <span className="when">{r.start.slice(11, 16)}</span>
                </>
              );
              // an incident with a position or a station goes there; one with neither stays a plain row
              return r.located || r.stationId || r.segmentId ? (
                <button
                  key={r.id}
                  className={`lrow${incidentId === r.id ? " active" : ""}`}
                  title={r.subtitle}
                  aria-current={incidentId === r.id ? "true" : undefined}
                  onClick={() => focusIncident(r.id)}
                >
                  {body}
                  <span className="chev">›</span>
                </button>
              ) : (
                <div key={r.id} className="lrow static" title={r.subtitle}>
                  {body}
                  <span />
                </div>
              );
            })
          ))}
      </div>
    </section>
  );
}
