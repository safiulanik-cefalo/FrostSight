import { useState } from "react";
import { LEVEL_COLOR } from "../../shared/contract";
import { useCurrentState, useShowcase } from "../data/store";
import { siteSummary } from "./format";
import { useSites } from "./useSites";

const ZONE: Record<string, string> = { coast: "Coast", fjord: "Fjord", inland: "Inland", mountain: "Mountain", warm: "Sheltered" };

export function SiteSwitcher() {
  const sites = useSites();
  const state = useCurrentState();
  const siteId = useShowcase((s) => s.siteId);
  const goSite = useShowcase((s) => s.goSite);
  const goOverview = useShowcase((s) => s.goOverview);
  const [open, setOpen] = useState(false);
  const current = sites.find((s) => s.station_id === siteId);
  const zones = [...new Set(sites.map((s) => s.climate))];
  return (
    <div className="switcher" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <button className="site" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="listbox">
        <span className="road">{current?.road ?? "Troms"}</span>
        <div>
          <b>{current?.name ?? "County overview"}</b>
          <small>{current && state ? siteSummary(state, current.station_id) : `${sites.length} stations`}</small>
        </div>
        <span className="chev">⌄</span>
      </button>
      {open && (
        <div className="menu glass" role="listbox">
          <button
            className={`menu-item${siteId ? "" : " active"}`}
            onClick={() => {
              goOverview();
              setOpen(false);
            }}
          >
            <span />
            <span>County overview</span>
            <small>Troms</small>
          </button>
          {zones.map((z) => (
            <div key={z}>
              <h4>{ZONE[z] ?? z}</h4>
              {sites
                .filter((s) => s.climate === z)
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
