import { describe, it, expect } from "vitest";
import { runStatement } from "./databricks";
import type { Env } from "./env";
import { scriptedFetch, memoryKV } from "./testkit";

const env = {
  STATE: memoryKV(), ASSETS: {} as Fetcher, DATABRICKS_HOST: "https://ws.example", DATABRICKS_WAREHOUSE_ID: "wh1",
  CATALOG: "frostsight", DATABRICKS_TOKEN: "tok",
} as Env;
const cols = { manifest: { schema: { columns: [{ name: "a" }, { name: "b" }] } } };

describe("runStatement", () => {
  it("posts the statement inline and maps rows by column name", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { statement_id: "s1", status: { state: "SUCCEEDED" }, ...cols, result: { data_array: [["1", "x"]] } },
    ]);
    expect(await runStatement(env, "SELECT 1", fetchFn, 0)).toEqual([{ a: "1", b: "x" }]);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(calls[0].url).toBe("https://ws.example/api/2.0/sql/statements/");
    expect(body).toMatchObject({ warehouse_id: "wh1", statement: "SELECT 1", wait_timeout: "30s", disposition: "INLINE", format: "JSON_ARRAY" });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("polls while the statement is pending or running", async () => {
    const { fetchFn, calls } = scriptedFetch([
      { statement_id: "s1", status: { state: "PENDING" } },
      { statement_id: "s1", status: { state: "RUNNING" } },
      { statement_id: "s1", status: { state: "SUCCEEDED" }, ...cols, result: { data_array: [["2", "y"]] } },
    ]);
    expect(await runStatement(env, "SELECT 2", fetchFn, 0)).toEqual([{ a: "2", b: "y" }]);
    expect(calls[1].url).toBe("https://ws.example/api/2.0/sql/statements/s1");
  });

  it("returns no rows when the result has no data array", async () => {
    const { fetchFn } = scriptedFetch([{ statement_id: "s1", status: { state: "SUCCEEDED" }, ...cols, result: {} }]);
    expect(await runStatement(env, "SELECT 3", fetchFn, 0)).toEqual([]);
  });

  it("rejects with the warehouse's message when the statement fails", async () => {
    const { fetchFn } = scriptedFetch([{ statement_id: "s1", status: { state: "FAILED", error: { message: "boom" } } }]);
    await expect(runStatement(env, "SELECT 4", fetchFn, 0)).rejects.toThrow(/boom/);
  });
});
