import { describe, it, expect } from "vitest";
import { outlookSteps } from "./outlook";

const history = [
  { t: "2026-10-12T06:00:00Z", level: "MEDIUM" as const, score: 0.48 },
  { t: "2026-10-12T06:40:00Z", level: "MEDIUM" as const, score: 0.55 },
  { t: "2026-10-12T09:20:00Z", level: "HIGH" as const, score: 0.72 },
];
const now = new Date("2026-10-12T09:40:00Z");

describe("outlookSteps", () => {
  it("shows 6 h ago, 3 h ago and now from the nearest readings", () => {
    const steps = outlookSteps(history, now);
    expect(steps.map((s) => s.label)).toEqual(["6 h ago", "3 h ago", "Now"]);
    expect(steps.map((s) => s.level)).toEqual(["MEDIUM", "MEDIUM", "HIGH"]);
    expect(steps.map((s) => s.score)).toEqual([0.48, 0.55, 0.72]);
    expect(steps.every((s) => !s.simulated)).toBe(true);
  });

  it("returns nothing when there is no history", () => {
    expect(outlookSteps([], now)).toEqual([]);
  });

  it("adds a scenario's future steps marked simulated", () => {
    const steps = outlookSteps(history, now, [{ at_h: 3, level: "HIGH", score: 0.78 }]);
    expect(steps[3]).toEqual({ label: "+3 h", at: "2026-10-12T12:40:00.000Z", level: "HIGH", score: 0.78, simulated: true });
  });
});

describe("outlookSteps with a current reading", () => {
  it("shows the current level at Now instead of the nearest history point", () => {
    const steps = outlookSteps(history, now, [], { level: "VERY_HIGH", score: 0.86 });
    expect(steps[2]).toMatchObject({ label: "Now", level: "VERY_HIGH", score: 0.86 });
    expect(steps[0].level).toBe("MEDIUM");
  });
});
