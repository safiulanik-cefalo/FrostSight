# Platform targets: Free Edition and AWS

Date: 28 September 2026. Sources: Databricks Free Edition docs (limitations page last updated 25 Sep 2026),
`overview.md`, `source-verification.md`.

## 1. Short answers

| Question | Answer |
|---|---|
| Can we create one project and invite all 5 engineers? | Yes. One Free Edition account has one workspace and one metastore; a workspace admin can add users (email OTP, Google or Microsoft sign-in). Users cannot be removed afterwards. |
| Can the MVP be built on Free Edition? | Yes, all of it, with three workarounds: an external collector for API pulls, triggered rather than continuous streaming, and one shared pipeline. |
| What cannot be done on Free Edition? | Continuous 24×7 streaming, live and replay pipelines side by side, more than 5 job tasks at once across the whole team, service-principal CI, model serving endpoints, workspace-admin topics (account console, SCIM, network config), any warehouse bigger than 2X-Small. |
| Cost to complete development and the MVP demo | Option A, all Free Edition: about $0 to $15 (a small static-IP VM for the collector). Option B, Free plus a paid workspace for the build milestones only: about $150, range $100 to $250. Option C, all paid: about $450, range $250 to $890. Recommendation: A, with B as the fallback decided at M2. |

## 2. Team setup on Free Edition

Recommended structure: **six accounts**.

| Account | Owner | Purpose |
|---|---|---|
| Team workspace | Safiul Kabir (admin), the other four added as users and admins | The integrated project: shared catalog `frostsight`, the one production-style pipeline, the scheduled job, the dashboard, the demo |
| Personal workspace × 5 | Each engineer | Experiments and individual development of their own tables before merging into the team workspace |

Why two layers: Free Edition quotas are **per account**, not per user. In one shared account the whole team gets
one active Lakeflow pipeline and five concurrent job tasks. Five engineers iterating on pipelines at the same
time would block each other. Personal accounts absorb the iteration; the team account runs the integrated,
scheduled system.

Practicalities:

- Sign-in is email OTP, Google or Microsoft. Cefalo Microsoft accounts work if the tenant allows it; otherwise
  personal Google accounts. No SSO or SCIM.
- Git folders per user, authenticated with a personal GitHub token, against `safiulanik-cefalo/FrostSight`.
- Everyone develops in a personal schema (`frostsight.dev_<name>`) and promotes through pull requests and the
  Asset Bundle deploy into `bronze`, `silver`, `gold`.
- Terms: non-commercial use only, fair-usage policy, no SLA, inactive accounts may be deleted. A non-commercial
  project on open public data qualifies. Do not put client data in it. Commercial use needs the paid target.

## 3. Services we need and their Free Edition status

| Service | Needed for | Free Edition | Notes and workaround |
|---|---|---|---|
| Unity Catalog: catalog, schemas, grants, lineage | Governance, layer separation | Yes | One metastore per account. Grants between the five users work. No account console. |
| Volumes | Landing zone for collector files | Yes | `frostsight.landing.<source>/` |
| Auto Loader and Structured Streaming | Road-weather and incident ingestion | Yes, serverless | Continuous mode will hit fair-usage quotas; run triggered (`availableNow`) every 10 to 30 min from a job |
| Lakeflow Declarative Pipelines | Bronze and silver, expectations, quarantine | Yes, one active pipeline per type per account | Put all flows in one pipeline. Replay runs in its own time slot, never beside live |
| Lakeflow Jobs | Orchestration, batch sources, gold, freshness | Yes, 5 concurrent tasks per account | Serialise the chain; keep team jobs few and short; personal experiments in personal accounts |
| Serverless SQL warehouse | Gold queries, dashboards | Yes, one 2X-Small | Enough for one pilot county; pre-aggregate map layers in gold |
| AI/BI dashboards | Risk map, road detail, priority list, health | Yes | Map via lat/lon or H3 layer |
| Genie | Optional natural-language layer | Yes | Nice for the demo, not in the MVP |
| SQL alerts | Alert delivery (stretch) | Yes, verify at M2 | Alert destinations may be email only |
| H3 and ST_ spatial functions | Station-to-segment mapping | Expected yes on serverless | Verify both function families at M0; fall back to H3 only, or to a Python geospatial library in a job |
| MLflow experiments and UC model registry | ML stretch | Yes | Batch inference into a gold table |
| Model Serving | Real-time prediction | Limited: few endpoints, no GPU, no provisioned throughput | Not needed; batch inference instead |
| Databricks Apps | Optional API | Yes, up to 3 per account | One FastAPI app if E4 has slack |
| Databricks CLI and Asset Bundles | Deploy jobs, pipeline, dashboard | Yes, with a user OAuth login or PAT | No service principals or account APIs: GitHub Actions deploys as a user. Document the gap |
| Git folders | Development | Yes | |
| Lakebase Postgres | Not needed | Yes | |
| Outbound internet from notebooks | Direct API pulls | Restricted to trusted domains | External collector writes files into a volume via the CLI |
| System tables for billing | Cost reporting | Not applicable | No billing on Free; report DBU counts from job run metadata instead |
| Custom compute, GPU, R, Scala | Not needed | No | |

Everything the MVP needs is available. The constraints are about concurrency and networking, not features.

## 4. What fits, milestone by milestone

| Milestone | On Free Edition | Constraint that bites | Workaround |
|---|---|---|---|
| M0 Sources verified | Yes | Notebooks cannot call NVDB, DATEX, Frost | Run the verification script from a laptop or GitHub Actions (done for NVDB, trafikkdata, MET) |
| M1 History and reference landed | Yes | Upload size and quotas for the NVDB extract and last winter's files | Pilot county only; upload with the CLI into a volume |
| M2 Foundation ready, gate | Yes | Collector needs a static IP for DATEX | Small VM or a Cefalo server runs the collector cron; GitHub Actions for the sources that do not need a fixed IP |
| M3 Design reviewed | Yes | none | |
| M4 Bronze and silver live | Yes | One active pipeline for the team | Single pipeline with both streams; personal accounts for iteration |
| M5 Risk computed | Yes | 5 concurrent tasks | Chain bronze → silver → gold serially in one job |
| M6 Product visible | Yes | 2X-Small warehouse; dashboard refresh competes with jobs | Pre-aggregate; refresh on a schedule, not on demand |
| M7 Hardened, demo-ready | Mostly | No SLA; no continuous stream for a live demo | Demo on replayed last-winter data in a dedicated slot; show live freshness separately |
| Replay (stretch) | Yes, sequentially | Cannot run beside live | Pause live during replay, or replay through a job instead of the pipeline |
| ML (stretch) | Yes | No serving | Batch predictions into `gold.road_segment_predicted_risk` |

## 5. What we cannot do on Free Edition, and whether it matters

| Not possible | Matters for the MVP? | Matters later? |
|---|---|---|
| Continuous 24×7 Structured Streaming | No. Triggered every 10 min matches the source cadence anyway | Only if a use case needs sub-minute latency |
| Two pipelines running at once (live plus replay) | No. Replay is a stretch goal and can run in a slot | No |
| More than 5 concurrent job tasks across the team | No, if we serialise. Yes if five people schedule test jobs at once | No |
| Service principals, account console, SCIM, network config | No | Yes for production operation; use the AWS target |
| Model serving endpoints | No | Only for real-time prediction; batch scoring covers the stretch scope |
| Larger SQL warehouse, custom clusters, performance tuning of cluster size | No for one county | Partly. Performance benchmarks are limited to file layout and incremental versus full refresh |
| Support and SLA | No | No |

## 6. Things we need outside Databricks, on any option

| Item | Cost | Notes |
|---|---|---|
| GitHub repo and Actions | $0 | 2,000 free minutes per month on a private repo; a 30-minute collector cadence uses about 1,500. Poll at 30 min, or make the repo public |
| Static-IP collector host for DATEX | $0 on a Cefalo server, otherwise about $5 per month for the smallest VM at a cloud provider | Runs a cron that pulls DATEX, Frost and NVDB, then `databricks fs cp` into the volume. Only needed if Statens vegvesen enforces the fixed-IP field |
| DATEX II account | $0 | Free form, NLOD licence, fixed IP or DNS name requested |
| MET Frost client ID | $0 | Email registration |
| NVDB, trafikkdata, MET Locationforecast, Open-Meteo elevation | $0 | Verified working with no registration on 28 Sep 2026 |

## 7. Cost to complete development and the MVP demo

Shared assumptions: about 8 weeks of effort, 5 engineers at 6 to 8 hours per week, pilot county only,
mid-2026 list prices to be verified. Development only; running costs after the demo are out of scope.

### Option A: everything on Free Edition

| Line | Cost |
|---|---|
| Databricks, six Free Edition accounts | $0 |
| Collector host | $0 to $15 for the whole period |
| Data sources | $0 |
| **Total** | **$0 to $15** |

Delivers: the full MVP (streaming road weather and incidents, NVDB, medallion, mapping, DQ and quarantine,
icing risk with drivers, risk map, road detail, health, freshness), replay in a slot, batch ML if time allows.
Does not deliver: continuous streaming, service-principal CI, workspace administration topics.

### Option B: Free Edition plus a paid workspace for the build milestones

Free Edition for all personal development and for M0 to M3. A paid serverless workspace on AWS from M4 to M7
for the integrated pipeline, continuous streaming tests, live-plus-replay, service-principal CI, and the demo.
Interactive development stays on Free, which removes the largest cost line.

| Line | Low | High |
|---|---|---|
| Streaming test runs, some continuous | $29 | $144 |
| Lakeflow pipeline runs | $9 | $65 |
| Scheduled jobs | $8 | $47 |
| SQL warehouse for dashboard and demo | $30 | $84 |
| Replay runs and spatial joins | $11 | $85 |
| Storage and other | $3 | $12 |
| Collector host | $0 | $15 |
| **Total** | **≈ $90** | **≈ $450** |

Expected about **$150**. A 14-day Databricks trial timed to M4 to M5 removes roughly a third of the
Databricks part, and AWS free tier covers storage on a new account.

### Option C: everything on a paid workspace

Expected about **$450**, range $250 to $890, as in the detailed document. Interactive development is half of it.

### Recommendation

Start on Option A. Decide at M2, when the collector is landing files and the first pipeline runs, whether the
one-pipeline and five-task limits are slowing the team. If they are, move only the team workspace to Option B
for M4 to M7. Option C buys nothing the MVP needs.

## 8. Actions

| Action | Owner | Milestone |
|---|---|---|
| Create the team Free Edition account, add the four others as admins, create catalog `frostsight` with schemas `landing`, `bronze`, `silver`, `gold`, `quarantine`, `ml`, `dev_<name>` | Rayhan | M0 |
| Each engineer creates a personal Free Edition account and connects the Git folder | All | M0 |
| Submit the DATEX access form; ask whether the fixed IP is enforced; register a Frost client ID | Shawon | M0 |
| Verify H3 and ST_ functions and SQL alerts on Free Edition serverless with one query each | Rayhan | M0 |
| Decide the collector host (Cefalo server or $5 VM) once the DATEX answer is in | Shawon, Rayhan | M2 |
| Re-evaluate Option B at the M2 gate using real pipeline run times and quota hits | Safiul | M2 |

## 9. Compared with Databricks on AWS (paid, pay-as-you-go)

"Databricks on AWS" today means a serverless workspace billed per second under the Premium or Enterprise tier,
with no minimum commitment. Express signup needs only an email and gives a serverless workspace without an
AWS account; the AWS Marketplace route bills through an existing AWS account. Both start with a 14-day trial
of Databricks usage credits. Personal-email trials are capped at one SQL warehouse of up to 50 DBU per hour
and no GPUs. Serverless bundles the cloud infrastructure into the DBU rate, so the only separate cloud cost
is storage if we bring our own S3 bucket.

| Dimension | Free Edition | Databricks on AWS, serverless pay-as-you-go |
|---|---|---|
| Setup | Sign up with an email, done | Express: email, then a card for pay-as-you-go after 14 days. Marketplace: AWS account, IAM role, billing. About an hour, plus billing alerts |
| Team of five | Yes, add users to the one workspace | Yes, plus SSO and SCIM if wanted, and real workspace administration |
| API pulls from notebooks | Restricted to trusted domains: collector required | Full outbound access by default on serverless: notebooks and jobs can call NVDB, DATEX, Frost directly. The DATEX fixed-IP question remains, since serverless egress IPs are not fixed either |
| Pipelines and jobs | One active pipeline and 5 concurrent tasks per account, shared by the team | Normal platform limits, effectively unlimited for us. Live and replay run side by side |
| Streaming | Triggered only, fair-usage quota | Continuous mode possible for demo and testing, at a cost per hour |
| SQL warehouse | One 2X-Small | Any size; trial caps at 50 DBU per hour |
| CI/CD | Deploy as a user, no service principals | Service principals, account APIs, proper Asset Bundle deployments |
| Workspace administration | Account console, SCIM, network policies not available | Available, except serverless egress control which needs Enterprise |
| Model serving | Limited | Full |
| Support and SLA | None | Standard |
| Cost for this project | $0, plus $0 to $15 for a collector host | About $450 expected, $250 to $890, at list prices. Serverless jobs list about $0.40 per DBU, slightly above the $0.35 used in the model. The 14-day trial removes roughly a third if timed to M4 to M5 |
| Cost risk | None | A stream or warehouse left running over a weekend costs $40 to $90. Someone's card is on file |
| Non-commercial restriction | Yes | No |

### Is it easier?

For development, yes. The three Free Edition workarounds disappear: no external collector for most sources,
no quota juggling between five engineers, real service-principal CI. For setup and operation, no: someone
becomes the billing owner and workspace admin, sets budget alerts, and watches for forgotten compute.

### Fewer limitations?

Yes, materially. Everything in section 5 becomes possible, and workspace administration (service principals,
SCIM, network policies) becomes available.

### Cheaper?

No. Free Edition is $0. The paid workspace is about $450 for the same scope, and nothing in the MVP requires
it. The one thing money buys that the MVP benefits from is convenience during M4 to M7.

### Recommendation, unchanged

Build on Free Edition. Use the express 14-day trial, which needs only an email, as a planned tool rather than
a fallback: start it at M4 so the team gets two weeks of unrestricted pipelines, continuous streaming tests,
service-principal CI and workspace administration, at no cost. Convert to
pay-as-you-go only if the M2 gate shows the Free Edition limits are costing real time; that is Option B at
about $150.

Sources: [Free trial](https://docs.databricks.com/aws/en/getting-started/free-trial),
[Serverless egress control](https://docs.databricks.com/aws/en/security/network/serverless-network-security/network-policies),
[Lakeflow Jobs pricing](https://www.databricks.com/product/pricing/lakeflow-jobs).

Sources: [Free Edition limitations](https://docs.databricks.com/aws/en/getting-started/free-edition-limitations),
[Free Edition overview](https://docs.databricks.com/aws/en/getting-started/free-edition).
