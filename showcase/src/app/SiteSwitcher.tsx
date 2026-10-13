import { useState } from "react";
import { LEVEL_COLOR } from "../../shared/contract";
import { useCurrentState, useShowcase } from "../data/store";
import { siteSummary } from "./format";
import { useRegion } from "./useRegion";
import { useSites } from "./useSites";

export function SiteSwitcher() {
  const sites = useSites();
  const state = useCurrentState();
  const regions = useShowcase((s) => s.regions);
  const siteId = useShowcase((s) => s.siteId);
  const goSite = useShowcase((s) => s.goSite);
  const goOverview = useShowcase((s) => s.goOverview);
  const region = useRegion();
  const [open, setOpen] = useState(false);
  const current = sites.find((s) => s.station_id === siteId);
  const inRegion = sites.filter((s) => s.region === region?.id).length;
  return (
    <div className="switcher" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <button className="site" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="listbox">
        <span className="road">{current?.road ?? region?.name.split(" ")[0] ?? "Troms"}</span>
        <div>
          <b>{current?.name ?? `${region?.name ?? "Troms"} overview`}</b>
          <small>{current && state ? siteSummary(state, current.station_id) : `${inRegion} stations`}</small>
        </div>
        <span className="chev">⌄</span>
      </button>
      {open && (
        <div className="menu glass" role="listbox">
          <h4>Overviews</h4>
          {regions.map((r) => (
            <button
              key={r.id}
              className={`menu-item${!siteId && r.id === region?.id ? " active" : ""}`}
              onClick={() => {
                goOverview(r.id);
                setOpen(false);
              }}
            >
              <span />
              <span>{r.name}</span>
              <small>{r.stations.length} stations</small>
            </button>
          ))}
          {regions.map((r) => (
            <div key={r.id}>
              <h4>{r.name}</h4>
              {sites
                .filter((s) => s.region === r.id)
                .map((s) => (
                  <button
                    key={s.station_id}
                    className={`menu-item${s.station_id === siteId ? " active" : ""}`}
                    onClick={() => {
                      goSite(s.station_id);
                      setOpen(false);
                    }}
                  >
                    <i style={{ width: 8, height: 8, borderRadius: "50%", background: LEVEL_COLOR[s.level ?? "NONE"] }} />
                    <span>{s.name}</span>
                    <small>{s.road}</small>
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
