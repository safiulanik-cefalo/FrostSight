# FrostSight

FrostSight estimates and explains winter road hazard on the Norwegian road network. It turns 10-minute
road-weather measurements, road incidents and the national road database (NVDB) into a risk level per road
segment, with the measurements that drive it. The first slice covers icing risk for Troms county.

It runs on Databricks: a collector lands source files in a Unity Catalog volume, a Lakeflow Declarative
Pipeline builds bronze and silver tables, a scheduled job computes the risk engine into gold tables, and
AI/BI dashboards show the result.

## Documentation

| Document | What it covers |
|---|---|
| [docs/overview.md](docs/overview.md) | Problem, scope, ownership, users and use cases |
| [docs/architecture.md](docs/architecture.md) | Data flow, design rules, integrations |
| [docs/adr/](docs/adr/) | Architecture decisions |
| [docs/plan/](docs/plan/00_README.md) | Implementation plan by milestone, M0 to M7 and stretch S1 to S3 |
| [docs/platform-targets.md](docs/platform-targets.md) | Free Edition and AWS targets, limits and cost |
| [docs/source-verification.md](docs/source-verification.md) | Live checks of every data source |

## Repository layout

```
databricks.yml     Asset Bundle: variables and the free, personal and aws targets
resources/         pipeline, job and dashboard definitions
src/frostsight/    Python package: transforms, windows, risk engine
src/pipelines/     Lakeflow Declarative Pipeline source
src/jobs/          job entry points
src/dashboards/    AI/BI dashboard definitions
collector/         source collector, runs outside Databricks
replay/            storm replay harness
sql/               one-time workspace setup
config/            source inventory and rule configuration
tools/             developer utilities
tests/             unit tests, data tests, fixtures
```

## Getting started

Requires Python 3.12, [uv](https://docs.astral.sh/uv/) and the Databricks CLI.

```bash
uv sync
uv run pytest
```

Workspace setup, CLI profiles and data-source access are in
[docs/plan/01_M0_accounts_and_sources.md](docs/plan/01_M0_accounts_and_sources.md).

## Data sources and attribution

Road data from Statens vegvesen (NVDB, DATEX II) under the Norwegian Licence for Open Government Data
(NLOD). Weather data from MET Norway and Open-Meteo under CC BY 4.0.
