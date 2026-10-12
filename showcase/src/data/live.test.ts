import { describe, it, expect } from "vitest";
import { loadState } from "./live";
import { baseState } from "./fixtures";

function fakeFetch(answers: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const a = answers[String(input)];
    if (!a) throw new Error("offline");
    return new Response(a.body, { status: a.status });
  }) as typeof fetch;
}
const ok = (v: unknown) => ({ status: 200, body: JSON.stringify(v) });

describe("loadState", () => {
  it("uses the Worker's live state when it is valid", async () => {
    const r = await loadState(fakeFetch({ "/api/state": ok(baseState()), "/snapshot.json": ok(baseState()) }));
    expect(r.via).toBe("live");
    expect(r.state.source).toBe("live");
  });

  it("falls back to the snapshot when the Worker has nothing", async () => {
    const r = await loadState(fakeFetch({ "/api/state": { status: 404, body: "{}" }, "/snapshot.json": ok(baseState()) }));
    expect(r.via).toBe("snapshot");
    expect(r.state.source).toBe("snapshot");
  });

  it("falls back to the snapshot when the Worker returns an invalid document", async () => {
    const r = await loadState(fakeFetch({ "/api/state": { status: 200, body: "not json" }, "/snapshot.json": ok(baseState()) }));
    expect(r.via).toBe("snapshot");
  });

  it("falls back to the snapshot when the Worker is unreachable", async () => {
    const r = await loadState(fakeFetch({ "/snapshot.json": ok(baseState()) }));
    expect(r.via).toBe("snapshot");
  });
});
