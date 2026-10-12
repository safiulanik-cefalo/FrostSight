import { describe, it, expect, beforeEach } from "vitest";
import { useShowcase, currentState } from "./store";
import { baseState } from "./fixtures";
import type { Scenario } from "./scenario";

const storm: Scenario = {
  id: "s", title: "Storm", blurb: "", duration_s: 60,
  steps: [{ at_s: 30, patch: { stations: [{ station_id: "3000014", risk_level: "VERY_HIGH" }] } }],
};

beforeEach(() => useShowcase.setState({ live: baseState(), via: "live", scenario: null, clockS: 0, playing: false }));

describe("store", () => {
  it("returns the live state when no scenario is on", () => {
    expect(currentState(useShowcase.getState())?.source).toBe("live");
  });

  it("plays a scenario and stops at its end", () => {
    useShowcase.getState().setScenario(storm);
    expect(useShowcase.getState().playing).toBe(true);
    useShowcase.getState().tick(45);
    expect(currentState(useShowcase.getState())?.stations[0].risk_level).toBe("VERY_HIGH");
    useShowcase.getState().tick(100);
    expect(useShowcase.getState().clockS).toBe(60);
    expect(useShowcase.getState().playing).toBe(false);
  });

  it("does not advance the clock while paused", () => {
    useShowcase.getState().setScenario(storm);
    useShowcase.getState().togglePlay();
    useShowcase.getState().tick(10);
    expect(useShowcase.getState().clockS).toBe(0);
  });

  it("moves between overview and a site and clears the selection", () => {
    useShowcase.getState().goSite("3000014");
    expect(useShowcase.getState()).toMatchObject({ view: "site", siteId: "3000014", segmentId: null });
    useShowcase.getState().goOverview();
    expect(useShowcase.getState()).toMatchObject({ view: "overview", siteId: null });
  });
});
