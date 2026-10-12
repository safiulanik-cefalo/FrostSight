import { describe, it, expect } from "vitest";
import { carPlan, openRanges, advanceCar } from "./cars";

describe("cars", () => {
  it("drives fewer, slower cars as the risk rises", () => {
    expect(carPlan("LOW")).toEqual({ count: 4, speed_mps: 22 });
    expect(carPlan("MEDIUM")).toEqual({ count: 4, speed_mps: 18 });
    expect(carPlan("HIGH")).toEqual({ count: 3, speed_mps: 13 });
    expect(carPlan("VERY_HIGH")).toEqual({ count: 2, speed_mps: 8 });
    expect(carPlan("NONE")).toEqual({ count: 3, speed_mps: 18 });
  });

  it("keeps cars out of closed stretches", () => {
    expect(openRanges(12000, [{ start_m: 4000, end_m: 6000 }])).toEqual([[0, 4000], [6000, 12000]]);
    expect(openRanges(12000, [])).toEqual([[0, 12000]]);
    expect(openRanges(12000, [{ start_m: 0, end_m: 12000 }])).toEqual([]);
  });

  it("wraps a car inside its open range in both directions", () => {
    expect(advanceCar(3990, 1, 20, 1, [0, 4000])).toBeCloseTo(10);
    expect(advanceCar(5, -1, 20, 1, [0, 4000])).toBeCloseTo(3985);
  });
});

import { placeCars } from "./cars";

describe("placeCars", () => {
  it("spreads cars over the longest open range in alternating directions", () => {
    const cars = placeCars(3, [[0, 4000], [6000, 12000]]);
    expect(cars.map((c) => c.dir)).toEqual([1, -1, 1]);
    expect(cars.every((c) => c.range[0] === 6000 && c.range[1] === 12000)).toBe(true);
    expect(cars.map((c) => c.pos)).toEqual([7000, 9000, 11000]);
  });

  it("places no cars when the whole corridor is closed", () => {
    expect(placeCars(3, [])).toEqual([]);
  });
});
