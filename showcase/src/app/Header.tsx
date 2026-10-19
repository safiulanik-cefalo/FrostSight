import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCurrentState, useShowcase } from "../data/store";
import { LEVEL_COLOR } from "../../shared/contract";
import { filterSites, liveChip } from "./format";
import { Icon } from "./icons";
import { SiteSwitcher } from "./SiteSwitcher";
import { useSites } from "./useSites";
import { usePlaceSearch } from "../map/usePlaceSearch";
import type { Place } from "../map/places";

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
  const mode = useShowcase((s) => s.mode);
  const goSite = useShowcase((s) => s.goSite);
  const focusStation = useShowcase((s) => s.focusStation);
  const focusPlace = useShowcase((s) => s.focusPlace);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const onMap = mode === "map";
  const hits = useMemo(() => filterSites(sites, q).slice(0, onMap ? 5 : 8), [sites, q, onMap]);
  // towns only on the map: the 3D view has no town to fly to
  const { places, searching } = usePlaceSearch(q, onMap);
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
  const done = () => {
    setQ("");
    setOpen(false);
    input.current?.blur();
  };
  const pick = (id: string) => {
    // on the map a pick pans to the station; in 3D it opens the station's diorama
    if (onMap) focusStation(id);
    else goSite(id);
    done();
  };
  const pickPlace = (place: Place) => {
    focusPlace(place);
    done();
  };
  const enter = () => {
    if (places[0]) pickPlace(places[0]);
    else if (hits[0]) pick(hits[0].station_id);
  };
  const label = onMap ? "Search towns, roads and stations" : "Search roads and stations";
  return (
    <div className="search">
      <label>
        <Icon.Search />
        <input
          id="search"
          ref={input}
          value={q}
          placeholder={label}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => e.key === "Enter" && enter()}
          aria-label={label}
        />
        <kbd>/</kbd>
      </label>
      {open && q.trim() && (
        <div className="menu glass" role="listbox">
          {places.length > 0 && <h4>Places</h4>}
          {places.map((p) => (
            <button key={`${p.name}|${p.kind}|${p.municipality}`} className="menu-item" onMouseDown={() => pickPlace(p)}>
              <i className="place-ic" />
              <span>{p.name}</span>
              <small>
                {p.kind}
                {p.municipality && p.municipality !== p.name.replace(/ kommune$/, "") ? ` · ${p.municipality}` : ""}
              </small>
            </button>
          ))}
          {onMap && places.length > 0 && hits.length > 0 && <h4>Stations and roads</h4>}
          {hits.length === 0 && places.length === 0 && (
            <div className="menu-empty">
              {searching ? "Searching places…" : onMap ? `No town, road or station matches “${q}”.` : `No station or road matches “${q}”.`}
            </div>
          )}
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

/** Map or 3D; the active one is a tinted pill. */
function ViewToggle() {
  const mode = useShowcase((s) => s.mode);
  const setMode = useShowcase((s) => s.setMode);
  return (
    <div className="seg" role="group" aria-label="View">
      <button aria-pressed={mode === "map"} onClick={() => setMode("map")}>
        Map
      </button>
      <button aria-pressed={mode === "3d"} onClick={() => setMode("3d")}>
        3D
      </button>
    </div>
  );
}

export function Header({ scenarioControl }: { scenarioControl?: ReactNode }) {
  const state = useCurrentState();
  const via = useShowcase((s) => s.via);
  const goOverview = useShowcase((s) => s.goOverview);
  const mode = useShowcase((s) => s.mode);
  const now = useNow();
  const chip = state ? liveChip(state, via, now) : null;
  const high = state ? state.kpi.segments_high : 0;
  return (
    <header className={`top${mode === "map" ? " on-map" : ""}`}>
      {mode === "3d" ? (
        <button className="brand" onClick={() => goOverview()} aria-label="FrostSight, back to the overview">
          <Icon.Brand />
          <span>FrostSight</span>
        </button>
      ) : (
        <div className="brand">
          <Icon.Brand />
          <span>FrostSight</span>
        </div>
      )}
      <ViewToggle />
      <Search />
      {mode === "3d" && <SiteSwitcher />}
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
