# Architecture

The detailed diagrams are in [`architecture.html`](architecture.html). Screen mock-ups are in
[`screens.html`](screens.html). Decisions are recorded in [`adr/`](adr/).

## Data flow

```mermaid
flowchart LR
  subgraph SRC[External sources]
    RW[DATEX II road weather<br/>every 10 min]
    INC[DATEX II incidents<br/>every 10 to 30 min]
    NVDB[NVDB API v4<br/>roads, stations, accidents, slides]
    FROST[MET Frost<br/>last winter's history]
    ELEV[Open-Meteo<br/>elevation]
  end

  COL[Collector<br/>Python package, cron outside Databricks<br/>job task on the AWS target]
  REPLAY[Replay harness<br/>stretch S1]

  subgraph WS[Databricks workspace: targets free, personal, aws]
    LAND[(Landing volume<br/>frostsight.landing.raw)]
    subgraph PIPE[Ingest pipeline, Lakeflow Declarative]
      BR[Bronze<br/>Auto Loader, append-only]
      SI[Silver<br/>live and replay flows<br/>watermark, dedup, rules]
      QU[Quarantine]
      LK[Station to segment lookup]
    end
    REF[Reference job, weekly]
    ORC[Orchestrate job, every 10 min<br/>pipeline update, build_gold, build_freshness]
    GOLD[(Gold tables<br/>current risk, history, summaries, freshness)]
    WH[SQL warehouse, serverless]
    DASH[Dashboards]
    ALERT[SQL alerts, S2]
    API[API app, S2]
    ML[ML batch prediction, S3]
  end

  RW --> COL
  INC --> COL
  NVDB --> COL
  FROST --> COL
  ELEV --> COL
  COL --> LAND
  REPLAY -.-> LAND
  LAND --> BR --> SI
  SI --> QU
  LAND --> REF --> LK
  ORC -. triggers .-> PIPE
  SI --> GOLD
  LK --> GOLD
  ORC --> GOLD
  GOLD --> WH
  WH --> DASH
  WH -.-> ALERT
  WH -.-> API
  GOLD -.-> ML
```

Three rules shape the design:

1. **Anything that calls an external URL lives in `collector/`.** Free Edition restricts outbound internet
   from notebooks and jobs, so the collector runs outside Databricks and writes files into the landing
   volume. On the AWS target the same code can run as a job task. Pipelines and jobs read only the
   landing volume and Unity Catalog tables.
2. **Same code on every target.** Everything is serverless. Target differences are bundle variables.
   See [`plan/00_README.md`](plan/00_README.md) section 2 and [`platform-targets.md`](platform-targets.md).
3. **One pipeline, one serial job.** Free Edition allows one active pipeline and five concurrent job tasks
   per account. Bronze, both silver flows, quarantine and the lookup share the ingest pipeline. Replay
   files use the same folders and reach silver through their own flow with their own watermark.

## Integrations

```mermaid
flowchart LR
  subgraph P[Data providers]
    D[DATEX II]
    N[NVDB v4]
    F[MET Frost]
    O[Open-Meteo]
  end
  subgraph I[Integration layer]
    C[Collector on GitHub Actions]
    H[Static-IP host, if DATEX needs it]
    R[GitHub repository]
    CI[CI and deploy workflows]
    S[Secrets]
  end
  subgraph W[Databricks]
    T[Team workspace, Free Edition]
    PW[Personal workspaces]
    A[AWS workspace, from M4]
  end
  subgraph U[People and clients]
    V[Dashboard viewers]
    E[Engineers]
    AR[Alert recipients, S2]
    AC[API clients, S2]
  end
  D -- 1 --> C
  D -. 1 alt .-> H
  N -- 2 --> C
  F -- 3 --> C
  O -- 4 --> C
  C -- 5 --> T
  H -.-> T
  R -- 12 --> CI
  S -- 11 --> CI
  CI -- 6 --> T
  CI -- 6 --> PW
  CI -- 6 --> A
  E -- 7 --> T
  E -- 7 --> PW
  E -- 7 --> A
  T -- 8 --> V
  T -. 9 .-> AR
  T -. 10 .-> AC
```

| # | From → to | Protocol and format | Authentication | Cadence | When |
|---|---|---|---|---|---|
| 1 | DATEX II → collector | HTTPS GET pull snapshot, XML, flattened to JSON lines | Basic auth from a free account; the form asks for a fixed IP or DNS name | 10 min road weather, 10 to 30 min incidents | M0 register, M2 live |
| 2 | NVDB v4 → collector | HTTPS REST, JSON, paged through `metadata.neste` | `X-Client` header, no key | Weekly | M1 |
| 3 | MET Frost → collector | HTTPS REST, JSON, chunked by month | Client ID | Once, for last winter | M1 |
| 4 | Open-Meteo → collector | HTTPS, JSON, up to 100 points per call | None | Once | M1 |
| 5 | Collector → landing volume | Databricks Files API through the Python SDK | Workspace token on Free Edition, service principal on AWS | Every 30 min | M2 |
| 6 | CI → workspaces | `databricks bundle validate` and `deploy` | User token on Free Edition, service principal OAuth on AWS | Every pull request and merge | M2, M4 for AWS |
| 7 | Engineers → workspaces | Databricks CLI, Git folders, `bundle deploy -t personal` | OAuth user login per CLI profile | While developing | M0 |
| 8 | Dashboards → viewers | AI/BI dashboards on the SQL warehouse | Workspace login, `CAN_READ` | Refreshes with the 10-minute job | M6 |
| 9 | Alerts → recipients | SQL alerts, email | Notification destination | After each job run | S2 |
| 10 | API → clients | Databricks App, HTTPS JSON | App login; the app's service principal reads gold | On request, 60-second cache | S2 |
| 11 | Secrets → CI and collector | Environment variables and a secret scope | DATEX account, Frost client ID, workspace token | Each run | M0 |
| 12 | Repository → CI | GitHub Actions on push and pull request | GitHub token | Every push | M2 |

Endpoint details and the live checks behind them are in [`source-verification.md`](source-verification.md).
The machine-readable inventory is [`config/sources.yml`](../config/sources.yml).
