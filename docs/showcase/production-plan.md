# FrostSight in production: budget, run interval and more counties

Written 2026-10-13 for the team and management. The budget and interval are a plan; the extra counties were built the same day (last section).

## Short answers

| Question | Answer |
|---|---|
| Budget for one year in production | **USD 6,050 per year**, about USD 505 a month on average. Includes a 20% reserve |
| Most expensive month | About USD 720 in a winter month, with the reserve |
| How often new data comes in | Every **30 minutes** in the icing season (October to April), every **3 hours** May to September |
| How old the data on screen gets | At most about 50 minutes in winter (30 min interval plus about 18 min to run) |
| Add Oslo? | **Done.** Oslo, Akershus and Innlandet were added beside Troms on 2026-10-13: 115 stations in all |

## What the budget covers

- The 3D dashboard is public with no login, hosted on Cloudflare, for a small group of users (up to about 50 people).
- Databricks is a paid serverless workspace on AWS (ADR-0003), Premium tier.
- Every feature built so far: ingestion, bronze and silver, gold, the AI/BI dashboards for the internal team, and the 3D showcase.
- The four monitored counties (see the last section). The extra counties add less than 10% to compute, and the reserve covers that.

## Pipeline run interval

The road authority's stations report every 10 minutes, but icing risk changes over tens of minutes, not seconds. Every
pipeline run costs the same whether anything changed or not, so the interval is the main cost lever.

| Interval, October to April | Data age on screen, worst case | Pipeline cost per winter month |
|---|---|---|
| 15 min | about 35 min | USD 1,050, and runs would overlap until silver is faster |
| **30 min (recommended)** | **about 50 min** | **USD 525** |
| 60 min | about 80 min | USD 263 |

- **October to April: every 30 minutes, day and night.** Black ice forms at night, so night runs are not skipped.
- **May to September: every 3 hours.** The dashboard stays live at USD 88 a month.
- One job runs the whole chain in order: ingest, silver, gold. The 3D dashboard then picks up the new data.

## Monthly budget

| Item | Winter month (Oct–Apr) | Summer month (May–Sep) | How it is worked out |
|---|---:|---:|---|
| Databricks pipeline (ingest, silver, gold) | 525 | 88 | 0.36 per run (below) × 1,459 runs in winter, 243 in summer |
| Databricks SQL warehouse for the AI/BI dashboards | 62 | 62 | 2X-Small, 4 DBU/h × 0.70 = 2.80 per hour, about 22 h a month of use |
| AWS storage and requests (S3) | 10 | 10 | Under 50 GB of tables and files |
| Cloudflare Workers Paid | 5 | 5 | Flat; includes the KV store and 10 M requests |
| **Subtotal** | **602** | **165** | |
| Reserve, 20% | 120 | 33 | Covers the EU region price, a slower month and the second county |
| **Total, USD** | **722** | **198** | |

**Year:** 7 × 722 + 5 × 198 = **USD 6,044, budgeted as USD 6,050.**

How a pipeline run is priced:

- Measured on the current jobs (last 10 to 15 runs): ingestion 320 s, silver 624 s, gold 123 s. That is 1,067 s, about 0.3 hours.
- Serverless jobs at about 3 DBU per hour of run time gives 0.9 DBU per run.
- At the list price of USD 0.40 per DBU, a run costs **USD 0.36**.
- The job's cost depends on these two assumptions. Check them in the first week against `system.billing.usage`, which the paid
  workspace has and Free Edition does not.

Not in the budget:

- Development work.
- A domain name; the plan assumes a subdomain of an existing company domain.
- Databricks paid support plans.

## Choices that keep the bill down

1. **The 3D dashboard stops waking the SQL warehouse.** Today its Worker queries the warehouse every 15 minutes, and each query
   wakes it up. That is about USD 200 a month for this alone.
   - Instead, the gold job writes the dashboard's state file into a Unity Catalog volume.
   - The Worker reads that file through the Databricks Files API, which uses no compute. Cost: USD 0.
   - The checks before storing stay the same. Visitors still never reach Databricks.
2. **One job runs the chain in order**, so nothing runs early and waits.
3. **Standard performance mode** for the serverless job. Start-up is slower, which is fine every 30 minutes, and it uses fewer
   DBUs than performance-optimised mode.
4. **The silver step is the longest, at about 10 minutes.** Making it incremental should bring a run under 8 minutes. That would
   cut the pipeline cost to less than half, about USD 230 a month in winter. The budget does not count on it.
5. **Auto-stop the SQL warehouse after 10 minutes.** The AI/BI dashboards are for the team, so the warehouse runs only while
   someone uses them.

## Before it goes public

| Item | Why |
|---|---|
| A service principal replaces the personal token | It may only read gold (and the state file) and use one warehouse |
| The state file in a volume, read through the Files API (choice 1) | Removes the warehouse from the public path, so visitors add no cost |
| Deploy the bundle to the AWS target; set the 30-minute and 3-hour schedules | The cadence above |
| Create the Cloudflare KV store, set the secret, deploy, choose a subdomain | Hosting |
| Cloudflare rate limiting on `/api/*` (included) | The page is public |
| Alerts on job failure and on data older than 90 minutes | Users must never see stale data without the team knowing |
| A budget alert in Databricks at USD 600 a month | An early warning before the yearly budget is at risk |

The health route already keeps error details private.

## More counties (built 2026-10-13)

**Oslo alone is too thin.** The road weather the pipeline already collects is national, and silver holds this many stations per
county today:

| County | NVDB number | Stations reporting | What it adds |
|---|---|---:|---|
| Oslo | 3 | 3 | The capital, but only three points on the map |
| Akershus | 32 | 30 | Around Oslo; busy commuter roads, coastal and inland |
| **Oslo and Akershus together** | 3 and 32 | 33 | **The capital region: city roads plus commuter routes; recognisable to any audience** |
| Innlandet | 34 | 55 | The coldest inland county, with mountain passes. ADR-0002's runner-up, and the strongest contrast to coastal Troms |

**Built:** all three counties, shown as three regions (Troms; Oslo and Akershus; Innlandet), 24 + 33 + 58 = 115 stations. What follows
was the recommendation and the plan; the differences from what was built are listed after it.

**Recommendation (before building):**
- For a demo that people recognise, add **Oslo and Akershus as one region**.
- For the strongest icing contrast with Troms, add **Innlandet**.
- Either one costs about the same to run.

What changes. The order matters, since each step feeds the next.

1. **Decision.** Amend ADR-0002 from "one pilot county" to "a list of counties". The bundle variable `pilot_county` becomes a
   list, for example `"55,3,32"`.
2. **Collector.** Loop the NVDB, traffic and incident calls over the counties. Incidents take one bounding box per county.
   Road weather is already national.
3. **Reference data.** Run `fetch_nvdb.py` per county, add a county column to the seed tables, and reload them.
4. **Gold.** Replace `COUNTY = "Troms"` with the list, add a county column to every serving table, and count the KPIs per county.
   Tests in `tests/unit/test_serving.py` follow.
5. **AI/BI dashboards.** Add a county filter.
6. **3D dashboard.**
   - Serve one state file per county (`/api/state/<county>`), and run the bake script for the new county's sites.
   - Add a county switch in the header, with an overview map per county.
   - In the overview, Oslo is mostly city with little relief, so it will look flatter than Troms. That is accurate.

Running cost: the national road-weather data is already collected, so a second county adds a few seconds to each run. The
20% reserve covers it.

What was built differs from the plan in three places:

- The county list lives in the reference seed (`silver.nvdb_seed_stations.county`), not a bundle variable. Gold reads it from there.
- `kpi_summary` stays one row for all counties. The 3D dashboard counts per region from the county column on each table.
- The 3D dashboard keeps one state file with a county on each row, not one file per county. The region switch is in the site
  switcher, not the header.

The AI/BI dashboard's county filter (step 5) is not built yet.

## Prices used

List prices on AWS in US dollars, checked 2026-10-13. EU regions can be a little higher; the reserve covers that. Confirm your own
rates in the paid workspace with `system.billing.list_prices`.

- Databricks serverless jobs and pipelines: USD 0.35 to 0.40 per DBU (the budget uses 0.40).
- Databricks serverless SQL: USD 0.70 per DBU, with the compute included.
- Cloudflare Workers Paid: USD 5 a month, including 10 M requests and KV with 10 M reads and 1 M writes a month.

Sources: [owox Databricks pricing](https://www.owox.com/blog/articles/databricks-pricing.md),
[Brilworks Databricks pricing](https://www.brilworks.com/blog/databricks-pricing-explained/),
[CostBench Databricks SQL](https://www.costbench.com/software/business-intelligence/databricks-sql/),
[Cloudflare KV pricing](https://developers.cloudflare.com/kv/platform/pricing),
[Cloudflare Workers calculator](https://makerkit.dev/pricing-calculator/cloudflare).
Run durations: Databricks Jobs API on the Free Edition workspace, 2026-10-13. Station counts: `silver.datex_road_weather_silver`,
the same day.
