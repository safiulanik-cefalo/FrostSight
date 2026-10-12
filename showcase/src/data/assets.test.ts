import { describe, it, expect } from "vitest";
import { decodeHeights } from "./assets";

describe("decodeHeights", () => {
  it("maps little-endian 16-bit samples onto min_m..max_m", () => {
    const buf = new Uint8Array([0x00, 0x00, 0xff, 0xff, 0x00, 0x80]).buffer;
    const h = decodeHeights(buf, 100, 300);
    expect(h[0]).toBe(100);
    expect(h[1]).toBe(300);
    expect(h[2]).toBeCloseTo(200, 0);
  });
});
