import { describe, it, expect, vi } from "vitest";
import worker, { refresh } from "./index";
import type { Env } from "./env";
import { scriptedFetch, memoryKV } from "./testkit";
import fixture from "../fixtures/gold_rows.json";
import { TABLE_KEYS } from "./queries";

type Rows = Record<string, Array<Record<string, unknown>>>;
const rows = fixture as unknown as Rows;

function answer(table: string) {
  const list = rows[table];
  const names = Object.keys(list[0] ?? { x: null });
  return {
    statement_id: table, status: { state: "SUCCEEDED" },
    manifest: { schema: { columns: names.map((name) => ({ name })) } },
    result: { data_array: list.map((r) => names.map((n) => r[n])) },
  };
}

function makeEnv(kv = memoryKV()): Env & { STATE: ReturnType<typeof memoryKV> } {
  return {
    STATE: kv, ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DATABRICKS_HOST: "https://ws.example", DATABRICKS_WAREHOUSE_ID: "wh1", CATALOG: "frostsight", DATABRICKS_TOKEN: "tok",
  } as Env & { STATE: ReturnType<typeof memoryKV> };
}
const now = new Date("2026-10-12T09:30:00Z");

describe("refresh", () => {
  it("writes state:current and reports updated", async () => {
    const env = makeEnv();
    const { fetchFn, calls } = scriptedFetch(TABLE_KEYS.map(answer));
    expect(await refresh(env, now, fetchFn)).toBe("updated");
    expect(calls).toHaveLength(9);
    const doc = JSON.parse(env.STATE.data.get("state:current")!);
    expect(doc.generated_at).toBe("2026-10-12T09:30:00.000Z");
    expect(doc.kpi.stations_total).toBe(2);
  });

  it("skips the other eight statements when risk_updated_at is unchanged", async () => {
    const env = makeEnv();
    await refresh(env, now, scriptedFetch(TABLE_KEYS.map(answer)).fetchFn);
    const later = new Date("2026-10-12T09:45:00Z");
    const { fetchFn, calls } = scriptedFetch([answer("kpi_summary")]);
    expect(await refresh(env, later, fetchFn)).toBe("unchanged");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(env.STATE.data.get("state:current")!).generated_at).toBe("2026-10-12T09:45:00.000Z");
  });

  it("rebuilds when the stored document is from an older Worker, even if gold has not changed", async () => {
    const env = makeEnv();
    await refresh(env, now, scriptedFetch(TABLE_KEYS.map(answer)).fetchFn);
    // a document an older Worker wrote: same gold, no shape version, no map points
    const old = JSON.parse(env.STATE.data.get("state:current")!);
    delete old.shape;
    delete old.map_points;
    env.STATE.data.set("state:current", JSON.stringify(old));
    const later = new Date("2026-10-12T09:45:00Z");
    const { fetchFn, calls } = scriptedFetch(TABLE_KEYS.map(answer));
    expect(await refresh(env, later, fetchFn)).toBe("updated");
    expect(calls).toHaveLength(9);
    expect(JSON.parse(env.STATE.data.get("state:current")!).map_points).toHaveLength(2);
  });

  it("keeps the previous document and records the error on failure", async () => {
    const env = makeEnv(memoryKV({ "state:current": '{"keep":true}' }));
    const { fetchFn } = scriptedFetch([new Error("network down")]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await refresh(env, now, fetchFn)).toBe("failed");
    expect(log).toHaveBeenCalledWith("refresh failed: network down");
    log.mockRestore();
    expect(env.STATE.data.get("state:current")).toBe('{"keep":true}');
    expect(JSON.parse(env.STATE.data.get("state:last_error")!)).toEqual({ at: "2026-10-12T09:30:00.000Z", message: "network down" });
  });
});

describe("fetch", () => {
  it("serves the state with max-age=60, and 404 when there is none", async () => {
    const empty = await worker.fetch(new Request("https://x/api/state"), makeEnv());
    expect(empty.status).toBe(404);
    expect(await empty.json()).toEqual({ error: "no state yet" });
    const env = makeEnv(memoryKV({ "state:current": '{"a":1}' }));
    const res = await worker.fetch(new Request("https://x/api/state"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("reports health without secrets", async () => {
    const env = makeEnv(memoryKV({
      "state:current": JSON.stringify({ generated_at: "g", gold: { risk_updated_at: "r" } }),
      "state:last_error": JSON.stringify({ at: "t", message: "Databricks 403 on https://dbc-0000.cloud.databricks.com/api/2.0/sql/statements/" }),
    }));
    const res = await worker.fetch(new Request("https://x/api/health"), env);
    const body = await res.json();
    // when it failed is public; why stays in KV and the Worker log, since it can name the workspace
    expect(body).toEqual({ generated_at: "g", risk_updated_at: "r", last_error: { at: "t", message: "The last refresh failed. Details are in the Worker log." } });
    expect(JSON.stringify(body)).not.toMatch(/databricks|dbc-|https?:/i);
  });

  it("hands every other path to the static assets", async () => {
    const res = await worker.fetch(new Request("https://x/"), makeEnv());
    expect(await res.text()).toBe("asset");
  });
});

describe("refresh validation", () => {
  it("keeps the previous document when gold yields a state the app would reject", async () => {
    const env = makeEnv(memoryKV({ "state:current": '{"keep":true}' }));
    const bad = JSON.parse(JSON.stringify(rows)) as Rows;
    bad.segment_detail[0].risk_level = "EXTREME";
    const answers = TABLE_KEYS.map((t) => {
      const list = bad[t];
      const names = Object.keys(list[0] ?? { x: null });
      return { statement_id: t, status: { state: "SUCCEEDED" }, manifest: { schema: { columns: names.map((name) => ({ name })) } },
        result: { data_array: list.map((r) => names.map((n) => r[n])) } };
    });
    expect(await refresh(env, now, scriptedFetch(answers).fetchFn)).toBe("failed");
    expect(env.STATE.data.get("state:current")).toBe('{"keep":true}');
    expect(JSON.parse(env.STATE.data.get("state:last_error")!).message).toMatch(/risk_level|invalid/i);
  });
});
