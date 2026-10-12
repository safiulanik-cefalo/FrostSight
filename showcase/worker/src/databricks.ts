// Databricks SQL Statement Execution API: run one SELECT on the warehouse and return its rows.
import type { Env } from "./env";

export type Row = Record<string, string | number | boolean | null>;

type StatementResponse = {
  statement_id: string;
  status: { state: string; error?: { message?: string } };
  manifest?: { schema?: { columns?: Array<{ name: string }> } };
  result?: { data_array?: Array<Array<string | null>> };
};

const TIMEOUT_MS = 60_000;

export async function runStatement(env: Env, sql: string, fetchFn: typeof fetch = fetch, pollMs = 2000): Promise<Row[]> {
  const headers = { Authorization: `Bearer ${env.DATABRICKS_TOKEN}`, "Content-Type": "application/json" };
  const base = `${env.DATABRICKS_HOST}/api/2.0/sql/statements/`;
  const started = Date.now();
  let res = await call(fetchFn, base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      warehouse_id: env.DATABRICKS_WAREHOUSE_ID,
      statement: sql,
      wait_timeout: "30s",
      disposition: "INLINE",
      format: "JSON_ARRAY",
    }),
  });
  while (res.status.state === "PENDING" || res.status.state === "RUNNING") {
    if (Date.now() - started > TIMEOUT_MS) throw new Error(`statement ${res.statement_id} still ${res.status.state} after 60 s`);
    if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
    res = await call(fetchFn, base + res.statement_id, { headers });
  }
  if (res.status.state !== "SUCCEEDED") {
    throw new Error(`statement ${res.statement_id} ${res.status.state}: ${res.status.error?.message ?? "no message"}`);
  }
  const names = (res.manifest?.schema?.columns ?? []).map((c) => c.name);
  return (res.result?.data_array ?? []).map((values) => Object.fromEntries(names.map((n, i) => [n, values[i] ?? null])));
}

async function call(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<StatementResponse> {
  const r = await fetchFn(url, init);
  if (!r.ok) throw new Error(`Databricks ${r.status} on ${url}`);
  return (await r.json()) as StatementResponse;
}
