import { describe, it, expect } from "vitest";
import config from "../vite.config";

describe("vite dev server", () => {
  it("never serves the Worker's local secrets file", () => {
    const deny = (config as { server?: { fs?: { deny?: string[] } } }).server?.fs?.deny ?? [];
    expect(deny).toContain(".dev.vars");
    expect(deny).toContain(".env");
  });
});
