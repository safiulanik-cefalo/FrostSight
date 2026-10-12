# FrostSight Showcase

A standalone 3D dashboard of winter road icing risk in Troms: a county overview and a low-poly diorama for each
of the 24 road weather stations, with the road coloured by risk, the station reporting, snow or rain from its
readings, closures as barriers, and glass panels with the numbers.

It is a demo built in parallel with the MVP, outside its milestones and the Asset Bundle (ADR-0010). It reads
the same plot-ready gold tables as the AI/BI dashboards and does not replace them. Cars on the page are
ambience, not traffic data. Design: `docs/superpowers/specs/2026-10-12-showcase-dashboard-design.md`.

## Run it locally

```bash
cd showcase
npm ci
npm run dev                # http://localhost:5173
```

Without a Worker the page uses `public/snapshot.json` and the header chip says "Snapshot". Scenarios work
without a Worker: switch on **Scenarios** in the header and pick one.

Links: `#overview` for the county, `#site=<station_id>` for a site, for example `#site=3000016` (Gardeborri).

## The Worker, locally

The Worker reads gold through the Databricks SQL Statement Execution API every 15 minutes and serves the
result at `/api/state`. The browser never sees a Databricks credential.

```bash
cp .dev.vars.example .dev.vars        # fill in a read-only token, the workspace host and the warehouse id
npm run build                         # the Worker serves dist/ as static assets
npx wrangler dev --test-scheduled     # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"   # run the cron once
curl -s http://localhost:8787/api/health
```

With the Worker on port 8787, `npm run dev` proxies `/api` to it and the chip turns to "Live".

### Capture a real snapshot

The committed `public/snapshot.json` is real gold from the Free Edition workspace, captured 2026-10-12. Refresh it
after a gold run:

```bash
curl -s http://localhost:8787/api/state > public/snapshot.json
npm run check                         # the snapshot must still parse
```

## Scene assets

`public/sites/` and `public/overview/` are baked from the NVDB seed (`tools/mock_dashboards/nvdb_seed.sql`),
Kartverket's county outline and Mapzen Terrarium elevation tiles. Re-run only when the seed changes:

```bash
npm run bake                          # uv run tools/bake_sites.py --out public
uv run tools/make_scenarios.py        # rewrites public/scenarios/ from the seed stations
```

## Tests

```bash
npm run check                         # TypeScript and Vitest
uv run pytest tests/unit/test_bake_sites.py   # from the repo root
```

Screenshot checklist before a demo: the overview, a site (Bossovarri `3000014`), "Snowstorm on E8" at 60 s
or later, and a 400 px wide window. A headless browser needs a few seconds before the first 3D frame.

## Deploy to Cloudflare (later)

```bash
npx wrangler kv namespace create STATE      # put the id in wrangler.toml
npx wrangler secret put DATABRICKS_TOKEN
# set DATABRICKS_HOST and DATABRICKS_WAREHOUSE_ID in wrangler.toml [vars]
npm run build && npx wrangler deploy
```

## Attribution

Road data Statens vegvesen (NLOD). Weather MET Norway and Open-Meteo (CC BY 4.0). Elevation Mapzen terrain
tiles.
