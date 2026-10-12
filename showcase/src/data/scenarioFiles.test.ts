import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseScenario, stateAt, closuresAt } from "./scenario";
import { parseState } from "../../shared/contract";
import { baseState } from "./fixtures";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../public/${p}`, import.meta.url), "utf8"));
const index = read("scenarios/index.json") as Array<{ id: string; title: string; blurb: string }>;
const snapshot = parseState(read("snapshot.json"));

describe("scenario files", () => {
  it("lists the three scenarios", () => {
    expect(index.map((s) => s.id)).toEqual(["snowstorm-e8", "black-ice-lavangsdalen", "quiet-morning"]);
  });

  for (const { id } of index) {
    it(`${id} is valid and gives a valid state over the snapshot and over a two-station base`, () => {
      const s = parseScenario(read(`scenarios/${id}.json`));
      expect(s.id).toBe(id);
      for (const base of [snapshot, baseState()]) {
        for (const t of [0, s.duration_s / 2, s.duration_s]) expect(() => parseState(stateAt(s, base, t))).not.toThrow();
      }
    });
  }

  it("snowstorm-e8 ends with Gardeborri very high and one closure", () => {
    const s = parseScenario(read("scenarios/snowstorm-e8.json"));
    const end = stateAt(s, baseState(), 90);
    expect(end.stations.find((x) => x.station_id === "3000016")?.risk_level).toBe("VERY_HIGH");
    expect(closuresAt(s, 90)).toHaveLength(1);
    expect(closuresAt(s, 59)).toHaveLength(0);
    expect(s.focus_station_id).toBe("3000016");
  });

  it("black ice reaches HIGH with no precipitation", () => {
    const s = parseScenario(read("scenarios/black-ice-lavangsdalen.json"));
    const seg = stateAt(s, baseState(), 60).segments.find((x) => x.station_id === "1900175")!;
    expect(seg.risk_level).toBe("HIGH");
    expect(seg.readings.precip_mm_h).toBe(0);
  });

  it("quiet morning puts every station at LOW", () => {
    const s = parseScenario(read("scenarios/quiet-morning.json"));
    const st = stateAt(s, snapshot, 30);
    expect(st.stations.length).toBeGreaterThanOrEqual(24);
    expect(st.stations.every((x) => x.risk_level === "LOW")).toBe(true);
  });
});
