// FrostSight showcase Worker: a cron that turns the plot-ready gold tables into one state document in KV,
// two small JSON routes, and the static app for everything else. The only place a Databricks credential lives.
import { runStatement, type Row } from "./databricks";
import type { Env } from "./env";
import { QUERIES, TABLE_KEYS, type TableKey } from "./queries";
import { shapeState, type GoldRows } from "./shape";

const CURRENT = "state:current";
const LAST_ERROR = "state:last_error";

export async function refresh(env: Env, now: Date, fetchFn: typeof fetch = fetch): Promise<"updated" | "unchanged" | "failed"> {
  const at = now.toISOString();
  try {
    const kpi = await runStatement(env, QUERIES.kpi_summary(env.CATALOG), fetchFn);
    const previousText = await env.STATE.get(CURRENT);
    const previous = previousText ? (JSON.parse(previousText) as { gold?: { risk_updated_at?: string | null } }) : null;
    const riskUpdatedAt = kpi[0]?.risk_updated_at ?? null;
    if (previous && riskUpdatedAt !== null && previous.gold?.risk_updated_at === String(riskUpdatedAt)) {
      await env.STATE.put(CURRENT, JSON.stringify({ ...previous, generated_at: at }));
      return "unchanged";
    }
    const rest = TABLE_KEYS.filter((k) => k !== "kpi_summary");
    const results = await Promise.all(rest.map((k) => runStatement(env, QUERIES[k](env.CATALOG), fetchFn)));
    const rows = Object.fromEntries([["kpi_summary", kpi] as [TableKey, Row[]], ...rest.map((k, i) => [k, results[i]] as [TableKey, Row[]])]) as GoldRows;
    await env.STATE.put(CURRENT, JSON.stringify(shapeState(rows, at)));
    return "updated";
  } catch (e) {
    await env.STATE.put(LAST_ERROR, JSON.stringify({ at, message: e instanceof Error ? e.message : String(e) }));
    return "failed";
  }
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/state") {
      const doc = await env.STATE.get(CURRENT);
      if (!doc) return json({ error: "no state yet" }, 404);
      return new Response(doc, { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
    }
    if (pathname === "/api/health") {
      const doc = await env.STATE.get(CURRENT);
      const err = await env.STATE.get(LAST_ERROR);
      const parsed = doc ? (JSON.parse(doc) as { generated_at?: string; gold?: { risk_updated_at?: string | null } }) : null;
      return json({
        generated_at: parsed?.generated_at ?? null,
        risk_updated_at: parsed?.gold?.risk_updated_at ?? null,
        last_error: err ? JSON.parse(err) : null,
      });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await refresh(env, new Date());
  },
};
