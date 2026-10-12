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

import { loadSiteAssets } from "./assets";

describe("loadSiteAssets", () => {
  it("rejects an unknown station and does not cache the failure", async () => {
    let calls = 0;
    const html = (async () => {
      calls++;
      return new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    await expect(loadSiteAssets("nope", html)).rejects.toThrow(/Unknown station nope/);
    await expect(loadSiteAssets("nope", html)).rejects.toThrow();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
