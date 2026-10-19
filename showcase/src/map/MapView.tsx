// The 2D map: Kartverket's grey-tone base map with the risk-coloured road points, stations and open incidents.
// No animation of its own; the viewer pans and zooms. Roads themselves come from the base map.
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { levelLabel, type Level } from "../../shared/contract";
import { useCurrentState, useShowcase } from "../data/store";
import { usePrefersReducedMotion } from "../hooks";
import { openIncidents, riskDots, stationMarkers } from "./layers";

const TILES = "https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png";
const VAR: Record<Level, string> = { LOW: "--low", MEDIUM: "--medium", HIGH: "--high", VERY_HIGH: "--very-high" };
/** Order worst last, so a HIGH point is drawn over a LOW one where they meet. */
const RANK: Record<Level, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 };

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Popup content built as DOM, so descriptions from the data are never parsed as HTML. */
function popup(title: string, level: Level | null | "none", detail: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "map-pop";
  const b = document.createElement("b");
  b.textContent = title;
  box.appendChild(b);
  if (level !== "none") {
    const pill = document.createElement("span");
    pill.className = `pill sm ${level ? level.toLowerCase().replace("_", "-") : "none"}`;
    pill.textContent = level ? `${levelLabel(level)} risk` : levelLabel(null);
    box.appendChild(pill);
  }
  if (detail) {
    const p = document.createElement("small");
    p.textContent = detail;
    box.appendChild(p);
  }
  return box;
}

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const state = useCurrentState();
  const focus = useShowcase((s) => s.mapFocus);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!el.current) return;
    // no attribution box: the legend credits Kartverket, as the tiles' CC BY 4.0 licence requires
    const m = L.map(el.current, { zoomControl: false, attributionControl: false, preferCanvas: true, minZoom: 4, maxZoom: 17, zoomSnap: 0.5 });
    L.control.zoom({ position: "topright" }).addTo(m);
    L.tileLayer(TILES, { maxZoom: 18 }).addTo(m);
    m.setView([64.5, 15], 5);
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    return () => {
      m.remove();
      map.current = null;
      layer.current = null;
      fitted.current = false;
    };
  }, []);

  // redraw on new data and when the theme flips, since marker colours come from the theme tokens
  useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group || !state) return;
    const draw = () => {
      group.clearLayers();
      const now = new Date();
      for (const d of [...riskDots(state)].sort((a, b) => RANK[a.level] - RANK[b.level])) {
        L.circleMarker([d.lat, d.lon], { radius: 5, stroke: false, fillColor: token(VAR[d.level]), fillOpacity: 1 })
          .bindPopup(popup(d.title, d.level, d.detail))
          .addTo(group);
      }
      for (const i of openIncidents(state, now)) {
        L.marker([i.lat, i.lon], { icon: L.divIcon({ className: "map-incident", html: "!", iconSize: [18, 18] }), title: i.title, keyboard: true })
          .bindPopup(popup(i.title, "none", i.detail))
          .addTo(group);
      }
      for (const s of stationMarkers(state, now)) {
        L.circleMarker([s.lat, s.lon], {
          radius: 7,
          weight: 2.5,
          color: token("--surface-solid"),
          fillColor: token(s.level ? VAR[s.level] : "--none"),
          fillOpacity: 1,
        })
          .bindPopup(popup(s.title, s.level, s.detail))
          .addTo(group);
      }
      if (!fitted.current && state.stations.length) {
        m.fitBounds(L.latLngBounds(state.stations.map((s) => [s.lat, s.lon] as [number, number])), { padding: [40, 40], animate: false });
        fitted.current = true;
      }
    };
    draw();
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    dark.addEventListener("change", draw);
    return () => dark.removeEventListener("change", draw);
  }, [state]);

  useEffect(() => {
    if (focus && map.current) map.current.setView([focus.lat, focus.lon], focus.zoom, { animate: !reduced });
  }, [focus, reduced]);

  return <div ref={el} className="map2d" role="region" aria-label="Map of road icing risk" />;
}
