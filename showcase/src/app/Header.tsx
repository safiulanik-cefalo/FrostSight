import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCurrentState, useShowcase } from "../data/store";
import { LEVEL_COLOR } from "../../shared/contract";
import { filterSites, liveChip } from "./format";
import { Icon } from "./icons";
import { SiteSwitcher } from "./SiteSwitcher";
import { useSites } from "./useSites";

function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Search() {
  const sites = useSites();
  const goSite = useShowcase((s) => s.goSite);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => filterSites(sites, q).slice(0, 8), [sites, q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const pick = (id: string) => {
    goSite(id);
    setQ("");
    setOpen(false);
    input.current?.blur();
  };
  return (
    <div className="search">
      <label>
        <Icon.Search />
        <input
          id="search"
          ref={input}
          value={q}
          placeholder="Search roads and stations"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => e.key === "Enter" && hits[0] && pick(hits[0].station_id)}
          aria-label="Search roads and stations"
        />
        <kbd>/</kbd>
      </label>
      {open && q.trim() && (
        <div className="menu glass" role="listbox">
          {hits.length === 0 && <div className="menu-empty">No station or road matches “{q}”.</div>}
          {hits.map((s) => (
            <button key={s.station_id} className="menu-item" onMouseDown={() => pick(s.station_id)}>
              <i className="dot" style={{ width: 8, height: 8, borderRadius: "50%", background: LEVEL_COLOR[s.level ?? "NONE"] }} />
              <span>{s.name}</span>
              <small>{s.road}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Header({ scenarioControl }: { scenarioControl?: ReactNode }) {
  const state = useCurrentState();
  const via = useShowcase((s) => s.via);
  const goOverview = useShowcase((s) => s.goOverview);
  const now = useNow();
  const chip = state ? liveChip(state, via, now) : null;
  const high = state ? state.kpi.segments_high : 0;
  return (
    <header className="top">
      <button className="brand" onClick={() => goOverview()} aria-label="FrostSight, back to the overview">
        <Icon.Brand />
        <span>FrostSight</span>
      </button>
      <Search />
      <SiteSwitcher />
      {chip && (
        <span className={`chip ${chip.tone}`}>
          <span className="dot" />
          {chip.text}
        </span>
      )}
      {scenarioControl}
      <div className="who">
        <div className="bell" title={`${high} segments at HIGH or above`}>
          <Icon.Bell />
          {high > 0 && <b>{high}</b>}
        </div>
        <div className="avatar">RO</div>
        <div>
          <b>Road operations</b>
          <small>Four counties</small>
        </div>
      </div>
    </header>
  );
}
