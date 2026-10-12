import { useCurrentState, useShowcase } from "../data/store";
import type { State } from "../../shared/contract";
import { Icon } from "./icons";
import { driverChip, incidentRows } from "./listRows";
import { LevelPill, ScoreBar, TonePill } from "./Pill";

const fmt = (v: number | null, unit: string, digits = 1) => (v === null ? "not reported" : `${v.toFixed(digits)} ${unit}`);
const CHIP_TONE = { Driver: "high", Rising: "medium", Minor: "none" } as const;

function CountyTop({ state }: { state: State }) {
  const goSite = useShowcase((s) => s.goSite);
  const top = [...state.segments].filter((s) => s.priority_rank !== null).sort((a, b) => (a.priority_rank ?? 99) - (b.priority_rank ?? 99)).slice(0, 5);
  return (
    <>
      <div className="phead">
        <div className="ic"><Icon.Road /></div>
        <div>
          <div className="eyebrow">County · Troms</div>
          <h2>Gritting priority</h2>
          <div className="addr">Highest icing risk first</div>
        </div>
      </div>
      <div className="rows">
        {top.length === 0 && <p className="empty">No segment has a current risk.</p>}
        {top.map((s) => (
          <button key={s.road_segment_id} className="row" onClick={() => s.station_id && goSite(s.station_id)}>
            <span className="rank">{s.priority_rank}</span>
            <span className="nm">{state.stations.find((x) => x.station_id === s.station_id)?.name ?? s.segment}<small>{s.road}</small></span>
            <LevelPill level={s.risk_level} small />
          </button>
        ))}
      </div>
    </>
  );
}

export function DetailPanel() {
  const state = useCurrentState();
  const siteId = useShowcase((s) => s.siteId);
  const segmentId = useShowcase((s) => s.segmentId);
  if (!state) return null;
  if (!siteId) {
    return (
      <aside className="glass panel" aria-label="County detail">
        <CountyTop state={state} />
      </aside>
    );
  }
  const station = state.stations.find((s) => s.station_id === siteId) ?? null;
  const segment =
    state.segments.find((s) => s.road_segment_id === segmentId) ?? state.segments.find((s) => s.station_id === siteId) ?? null;
  const closure = incidentRows(state, siteId, new Date()).find((i) => i.active && i.closure && i.segmentId === segment?.road_segment_id);
  const simulated = state.source === "scenario";
  return (
    <aside className="glass panel" aria-label="Segment detail">
      <div className="phead">
        <div className="ic"><Icon.Road /></div>
        <div>
          <div className="eyebrow">Segment · {segment?.road ?? station?.road}</div>
          <h2>{segment ? state.stations.find((s) => s.station_id === segment.station_id)?.name ?? segment.segment : station?.name}</h2>
          <div className="addr">
            {segment?.road_segment_id ?? station?.road_segment_id} · {station ? `${station.lat.toFixed(3)} N ${station.lon.toFixed(3)} E` : ""}
          </div>
        </div>
      </div>
      {!segment ? (
        <>
          <div className="status"><LevelPill level="NONE" /> No current risk for this station</div>
          <p className="empty">
            The station {station?.status === "Stale" ? "has not reported in the newest fetch" : "has no scored segment yet"}, so its road shows
            no coverage.
          </p>
        </>
      ) : (
        <>
          <div className="status">
            <LevelPill level={segment.risk_level} />
            {simulated && <TonePill tone="sim">Simulated</TonePill>}
            <span>icing {segment.icing_score.toFixed(2)}</span>
          </div>
          <div className="meters">
            <div className="meter">
              <div className="lab">Icing score</div>
              <div className="v">{segment.icing_score.toFixed(2)} <small>/ 1.00</small></div>
              <ScoreBar score={segment.icing_score} level={segment.risk_level} />
            </div>
            <div className="meter">
              <div className="lab">Station · {station?.name}</div>
              <div className="v">{station?.status ?? "Unknown"} <small>{station?.last_event_time?.slice(11, 16) ?? ""}</small></div>
              <ScoreBar score={station?.status === "Reporting" ? 1 : 0.15} level={station?.status === "Reporting" ? "LOW" : "NONE"} />
            </div>
            <div className="meter">
              <div className="lab">Surface</div>
              <div className="v">{fmt(segment.surface_c, "°C")}</div>
            </div>
            <div className="meter">
              <div className="lab">Change, 1 h</div>
              <div className="v">{segment.change_1h_c === null ? "not reported" : `${segment.change_1h_c > 0 ? "+" : ""}${segment.change_1h_c.toFixed(1)} °C`}</div>
            </div>
          </div>
          <div className="sec">Drivers <small>share of the icing score</small></div>
          <div className="rows">
            {segment.drivers.length === 0 && <p className="empty">No driver breakdown for this reading.</p>}
            {segment.drivers.map((d) => (
              <div key={d.factor} className="row static">
                <span className="nm">{d.factor}</span>
                <span className="vv">{Math.round(d.contribution * 100)} %</span>
                <TonePill tone={CHIP_TONE[driverChip(d.contribution)]}>{driverChip(d.contribution)}</TonePill>
              </div>
            ))}
          </div>
          <div className="sec">Readings <small>{segment.event_time ? `${segment.event_time.slice(11, 16)} UTC` : ""}</small></div>
          <div className="rows">
            <div className="row static"><span className="nm">Air</span><span className="vv">{fmt(segment.air_c, "°C")}</span></div>
            <div className="row static"><span className="nm">Dew point</span><span className="vv">{fmt(segment.readings.dew_point_c, "°C")}</span></div>
            <div className="row static">
              <span className="nm">Precipitation</span>
              <span className="vv">{segment.readings.precip_type ? `${segment.readings.precip_type.toLowerCase()}${segment.readings.precip_mm_h !== null ? `, ${segment.readings.precip_mm_h.toFixed(1)} mm/h` : ""}` : "not reported"}</span>
            </div>
            <div className="row static"><span className="nm">Wind</span><span className="vv">{fmt(segment.readings.wind_ms, "m/s", 0)}</span></div>
          </div>
          <div className="sec">Gritting <small>{segment.priority_rank ? `priority ${segment.priority_rank} in Troms` : "not ranked"}</small></div>
          {closure && (
            <div className="rows">
              <div className="row static">
                <span className="nm">{closure.title}<small>{closure.subtitle}</small></span>
                <TonePill tone={simulated ? "sim" : "high"}>{simulated ? "Simulated" : "Active"}</TonePill>
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
