# M1: History and reference data landed

Owners: Shawon (collector, Frost, DATEX), Rayhan (landing volume, NVDB extract, elevation, contracts).
Requires the M0 gate. Read `00_README.md` sections 3 and 4 for the package layout and the landing path.

Goal: the `collector/` package exists and has put real files for the pilot county (Troms,
`fylke=55`) into `/Volumes/frostsight/landing/raw/`. Every dataset has exactly one flat folder under
`raw/` (README section 4, "Landing sources"), so each Auto Loader stream or batch reader at M4 watches
exactly one folder:

| Dataset | Landing folder | File | Content |
|---|---|---|---|
| NVDB road links | `nvdb_road_network/` | `<ts>.jsonl` | segmented link sequences for the county, one NVDB object per line |
| NVDB stations (153) | `nvdb_stations/` | `<ts>.jsonl` | road-weather stations with `Målestasjonsnummer` and point geometry |
| NVDB speed limits (105) | `nvdb_speed_limits/` | `<ts>.jsonl` | speed limit objects with link references |
| NVDB accidents (570) | `nvdb_accidents/` | `<ts>.jsonl` | last five years (`Ulykkesdato >= 2021-01-01`) |
| NVDB avalanche and landslide (445) | `nvdb_avalanche/` | `<ts>.jsonl` | all years |
| NVDB counties | `nvdb_counties/` | `<ts>.jsonl` | `omrader/fylker`, one county per line (`nummer`, `navn`) |
| Frost sources | `frost_sources/` | `<ts>.jsonl` | Statens vegvesen stations in the county: `source_id`, `name`, `lat`, `lon`, `station_id` |
| Frost history | `frost_history/` | `<month start>_<SNid>.jsonl` | Nov 2025 to Mar 2026, PT10M, one observation per line: `station_id`, `event_time`, elements |
| DATEX road weather | `road_weather/` | `<ts>.jsonl` | flat JSON lines, contract v1 (section "Contract v1"), once credentials exist |
| DATEX road weather, raw | `road_weather_xml/` | `<ts>.xml` | the snapshot as received; never read by the pipeline |
| DATEX situations | `road_incidents/` | `<ts>.jsonl` | flat JSON lines, contract v1 |
| DATEX situations, raw | `road_incidents_xml/` | `<ts>.xml` | the snapshot as received |
| DATEX site table | `datex_sites/` | `<ts>.jsonl` | `site_id`, `name`, `lat`, `lon` per measurement site; joins DATEX ids to NVDB stations at M4 |
| Open-Meteo elevation | `elevation/` | `<ts>_fylke55.jsonl` | elevation per station point |
| Source metadata | `source_metadata/` | `<ts>.jsonl` | one line per source: endpoint, licence, attribution, cadence |

`<ts>` is the collection time in UTC, `20261005T090000Z`. Replay files (M2 harness) go into the same
`road_weather/` and `road_incidents/` folders as `replay__<event_id>__<ts>__r<run start>.jsonl`; bronze derives
`_batch_id` from the file name (README section 4), so the collector never writes a `_batch_id` field.

Plus: data contracts for every landed source, two or three replay storm days in
`config/replay_events.yml`, and a note on idempotent file naming.

Endpoint facts below come from `../source-verification.md` and from live probes made
while writing this plan (28 Sep 2026). Anything not probed is marked "verify:".

| Task | Owner | Depends on |
|---|---|---|
| T1.1 Catalog, schemas and landing volume (SQL, once per workspace) | Rayhan | M0 gate |
| T1.2 Collector package: `common.py`, `run.py`, `config/sources.yml` | Shawon | T0.3 |
| T1.3 `nvdb.py` and the NVDB extract | Rayhan | T1.1, T1.2 |
| T1.4 `frost.py` and last winter's observations | Shawon | T1.1, T1.2, T1.3 (stations file), Frost id |
| T1.5 `datex.py`: contract v1, first snapshot pair, site table | Shawon | DATEX account |
| T1.6 `elevation.py` for station points | Rayhan | T1.3 |
| T1.7 Data contracts | Rayhan, Shawon | T1.3 to T1.6 |
| T1.8 Replay storm days | Shawon | T1.4 |
| T1.9 Backfill and idempotency note, unit tests on fixtures | Shawon | T1.2 |

### T1.1 Catalog, schemas and landing volume      owner: Rayhan
Why: the collector needs a place to write. README section 2, rule 5: the catalog, the six schemas, the
landing volume and the grants are created by one SQL script, run once per workspace, never by the
bundle (`mode: development` renames bundle resources, and Free Edition has one metastore anyway).
Do:
  1. Create `sql/001_catalog_schemas_volume.sql`. It is idempotent; re-run it after any change.
     ```sql
     -- 001_catalog_schemas_volume.sql: run once per workspace (team and every personal one).
     -- Free Edition has one metastore; the catalog is created once by the first admin.
     CREATE CATALOG IF NOT EXISTS frostsight COMMENT 'FrostSight project';
     USE CATALOG frostsight;

     -- Layer schemas (00_README section 4)
     CREATE SCHEMA IF NOT EXISTS landing    COMMENT 'Raw files from the collector and the replay harness';
     CREATE SCHEMA IF NOT EXISTS bronze     COMMENT 'Source records as received, plus ingestion metadata';
     CREATE SCHEMA IF NOT EXISTS silver     COMMENT 'Normalised, validated, deduplicated, mapped to segments';
     CREATE SCHEMA IF NOT EXISTS gold       COMMENT 'Risk, summaries, freshness; what dashboards read';
     CREATE SCHEMA IF NOT EXISTS quarantine COMMENT 'Rows that failed a rule, with the rule and reason';
     CREATE SCHEMA IF NOT EXISTS ml         COMMENT 'Features, labels and registered models (stretch)';

     -- Landing volume. Managed: Databricks owns the storage. Path: /Volumes/frostsight/landing/raw/...
     CREATE VOLUME IF NOT EXISTS landing.raw COMMENT 'Landing zone: raw/<source>/<yyyy>/<mm>/<dd>/<ts>.<ext>';

     -- Grants. `account users` is the account-level group every workspace user belongs to; Unity Catalog
     -- grants take account-level principals, not the workspace-local `users` group.
     GRANT USE CATALOG ON CATALOG frostsight TO `account users`;
     GRANT USE SCHEMA, SELECT ON SCHEMA frostsight.gold TO `account users`;      -- read-only gold for everyone
     GRANT USE SCHEMA, SELECT ON SCHEMA frostsight.silver TO `account users`;    -- dashboards join silver.road_segments

     -- Write privileges per engineer (the catalog owner runs this; replace with the real sign-in identities).
     -- Repeat the block for each of the five engineers.
     GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.landing    TO `sani@example.com`;
     GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.bronze     TO `sani@example.com`;
     GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.silver     TO `sani@example.com`;
     GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.gold       TO `sani@example.com`;
     GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.quarantine TO `sani@example.com`;
     GRANT USE SCHEMA, CREATE TABLE, CREATE MATERIALIZED VIEW, SELECT, MODIFY ON SCHEMA frostsight.ml         TO `sani@example.com`;
     GRANT READ VOLUME, WRITE VOLUME ON VOLUME frostsight.landing.raw TO `sani@example.com`;

     SHOW GRANTS ON SCHEMA frostsight.silver;
     SHOW GRANTS ON VOLUME frostsight.landing.raw;
     ```
  2. Run it on the team workspace as the admin: open SQL Editor, pick the serverless warehouse
     (Free Edition gives one; note its exact name, it becomes the bundle variable `warehouse_name`),
     paste the file, Run all. Alternative from the CLI, one statement at a time:
     `databricks experimental aitools tools query "CREATE CATALOG IF NOT EXISTS frostsight" --profile frostsight-free`
     (verify: whether the command accepts a multi-statement script; if not, the SQL editor is the way).
  3. Repeat on your personal workspace with `--profile frostsight-personal` or in its SQL editor, without
     the per-user grant block (you are alone there). Same names, own metastore, no collision (README
     section 2, rule 4).
  4. Path convention. A volume is a governed folder; the full path is
     `/Volumes/<catalog>/<schema>/<volume>/...`, here `/Volumes/frostsight/landing/raw/`. Inside it
     the README convention is `<source>/<yyyy>/<mm>/<dd>/<UTC timestamp>.<ext>` with one flat `<source>`
     folder per dataset (table at the top of this file). The date folders use the collection time in
     UTC, not the event time; event time lives inside the file. The CLI needs the `dbfs:` prefix in front
     of `/Volumes/...` or it treats the path as local. In SQL and in the SDK the path has no prefix.
  5. Create the source folders so `fs ls` works before the first upload:
     ```bash
     for d in nvdb_road_network nvdb_stations nvdb_speed_limits nvdb_accidents nvdb_avalanche nvdb_counties \
              frost_sources frost_history road_weather road_weather_xml road_incidents road_incidents_xml \
              datex_sites elevation source_metadata; do
       databricks fs mkdirs dbfs:/Volumes/frostsight/landing/raw/$d --profile frostsight-free
     done
     databricks fs ls dbfs:/Volumes/frostsight/landing/raw/ --profile frostsight-free
     ```
  6. Ownership. The creator owns each object: the admin who runs step 2 owns the catalog, schemas and
     volume and is the only one who can `GRANT` on them. Tables created by other engineers are owned by
     them. Hand over with `ALTER TABLE frostsight.silver.x OWNER TO \`rayhan@example.com\``. On AWS
     at M4, transfer ownership of the schemas to the service principal that runs the jobs.
Expect: `SHOW GRANTS ON SCHEMA frostsight.silver` lists `USE_SCHEMA`, `CREATE_TABLE`,
`CREATE_MATERIALIZED_VIEW`, `SELECT`, `MODIFY` per engineer; `databricks volumes list frostsight landing
--profile frostsight-free` shows `raw`, `volume_type: MANAGED` (verify: the positional form of
`volumes list` in your CLI version; `databricks volumes list --help`); `fs ls` lists fifteen folders.
If it fails:
  - `PERMISSION_DENIED` on `CREATE CATALOG`: your user is not metastore admin. On Free Edition the
    first workspace admin is; ask Safiul to run the script, or to grant `CREATE CATALOG` on the metastore.
    verify: which user holds metastore admin (`databricks metastores current --profile frostsight-free`).
  - `Principal not found` on a `GRANT`: the email differs from the sign-in identity, or you wrote `users`
    instead of `account users`. Settings > Identity and access > Users has the exact string.
  - `fs mkdirs` says `no such directory`: the `dbfs:` prefix is missing.

### T1.2 Collector package: `common.py`, `run.py`, `config/sources.yml`      owner: Shawon
Why: one set of HTTP, naming and upload helpers, reused by every source module. No Spark; the
package must run on a laptop, in GitHub Actions, on a static-IP host and as a job task on the `aws`
target without changes (ADR 0004). Only the delivery target differs.
Do:
  1. Create `collector/__init__.py` (empty) and `collector/common.py`:
     ```python
     """Shared helpers for the collector: HTTP session, landing paths, local write, delivery.

     No Spark here. The same code runs on a laptop, in GitHub Actions, on a static-IP host, or as a
     job task on the aws target. Only the delivery target differs:
       local      -> data/landing/raw/... on this machine
       free/personal/aws -> the landing volume through the Files API, using the matching CLI profile
       workspace  -> the landing volume through its /Volumes path (inside a job task, plain file IO)
     """

     from __future__ import annotations

     import json
     import logging
     import os
     import shutil
     from collections.abc import Iterable
     from datetime import datetime, timedelta, timezone
     from pathlib import Path

     import requests
     from requests.adapters import HTTPAdapter
     from urllib3.util.retry import Retry

     log = logging.getLogger("collector")

     USER_AGENT = os.environ.get(
         "MET_USER_AGENT", "frostsight-collector/0.1 github.com/safiulanik-cefalo/FrostSight"
     )
     VOLUME_ROOT = os.environ.get("FROSTSIGHT_LANDING_ROOT", "/Volumes/frostsight/landing/raw")
     LOCAL_ROOT = Path(os.environ.get("FROSTSIGHT_LOCAL_ROOT", "data/landing/raw"))
     PROFILES = {"free": "frostsight-free", "personal": "frostsight-personal", "aws": "frostsight-aws"}
     TARGETS = (*PROFILES, "workspace", "local")


     def session(
         headers: dict[str, str] | None = None,
         auth: tuple[str, str] | None = None,
         retries: int = 5,
     ) -> requests.Session:
         """A requests session with exponential backoff on 429 and 5xx and our User-Agent."""
         s = requests.Session()
         retry = Retry(
             total=retries,
             backoff_factor=1.5,
             status_forcelist=(429, 500, 502, 503, 504),
             allowed_methods=("GET", "POST"),
             respect_retry_after_header=True,
         )
         s.mount("https://", HTTPAdapter(max_retries=retry))
         s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
         if headers:
             s.headers.update(headers)
         if auth:
             s.auth = auth
         return s


     def utc_now() -> datetime:
         return datetime.now(timezone.utc).replace(microsecond=0)


     def landing_path(source: str, ts: datetime, ext: str, suffix: str = "") -> str:
         """<source>/<yyyy>/<mm>/<dd>/<UTC timestamp><suffix>.<ext>, relative to the volume root.

         The name is deterministic for (source, ts, suffix), which is what makes re-runs safe.
         """
         if ts.tzinfo is None or ts.utcoffset() != timedelta(0):
             raise ValueError("ts must be timezone-aware UTC")
         if "/" in source:
             raise ValueError("source is one flat folder name, e.g. nvdb_stations (00_README section 4)")
         return f"{source}/{ts:%Y/%m/%d}/{ts:%Y%m%dT%H%M%SZ}{suffix}.{ext}"


     def write_bytes(rel_path: str, content: bytes) -> Path:
         path = LOCAL_ROOT / rel_path
         path.parent.mkdir(parents=True, exist_ok=True)
         path.write_bytes(content)
         return path


     def write_jsonl(rel_path: str, rows: Iterable[dict]) -> tuple[Path, int]:
         """Stream rows to a JSON-lines file; returns the path and the row count."""
         path = LOCAL_ROOT / rel_path
         path.parent.mkdir(parents=True, exist_ok=True)
         n = 0
         with path.open("w", encoding="utf-8") as fh:
             for row in rows:
                 fh.write(json.dumps(row, ensure_ascii=False))
                 fh.write("\n")
                 n += 1
         return path, n


     def upload(local_path: Path, rel_path: str, profile: str) -> str:
         """Upload one file into the landing volume with the Databricks SDK Files API."""
         from databricks.sdk import WorkspaceClient  # local import: --target local needs no SDK

         w = WorkspaceClient(profile=profile)
         volume_path = f"{VOLUME_ROOT}/{rel_path}"
         w.files.create_directory(volume_path.rsplit("/", 1)[0])
         with local_path.open("rb") as fh:
             w.files.upload(volume_path, fh, overwrite=True)
         log.info("uploaded %s (%d bytes)", volume_path, local_path.stat().st_size)
         return volume_path


     def deliver(local_path: Path, rel_path: str, target: str) -> str:
         """Return where the file ended up: a local path for --target local, else the volume path."""
         if target == "local":
             return str(local_path)
         if target == "workspace":  # inside a job task: /Volumes is mounted as a normal file system
             dest = Path(VOLUME_ROOT) / rel_path
             dest.parent.mkdir(parents=True, exist_ok=True)
             shutil.copyfile(local_path, dest)
             log.info("copied %s (%d bytes)", dest, local_path.stat().st_size)
             return str(dest)
         return upload(local_path, rel_path, PROFILES[target])
     ```
     `WorkspaceClient().files.upload(file_path, contents, overwrite=)` is the real SDK signature
     (checked against `databricks-sdk` 0.140.0 in the repo's venv). `create_directory` is
     idempotent. verify: the Files API also creates parent folders on its own; the explicit call
     is harmless either way. verify at M4 on `aws`: plain file IO to `/Volumes/...` from a serverless
     job task (it is documented for notebooks and Python tasks; if the path is missing, fall back to
     `upload()` with `WorkspaceClient()` and no profile, which uses the job's own identity).
  2. Create `collector/run.py`:
     ```python
     """Collector entry point. One or more sources per run, one delivery target.

     Examples:
       python -m collector.run --source nvdb --county 55 --target local
       python -m collector.run --source frost --county 55 --from 2025-11-01 --to 2026-04-01 --target free
       python -m collector.run --source road_weather road_incidents --target free
       python -m collector.run --source datex_sites elevation metadata --county 55 --target free
     """

     from __future__ import annotations

     import argparse
     import logging
     import os
     import sys
     from datetime import date

     from collector import datex, elevation, frost, metadata, nvdb
     from collector.common import TARGETS

     SOURCES = ("nvdb", "frost", "road_weather", "road_incidents", "datex_sites", "elevation", "metadata")
     SECRET_KEYS = {"DATEX_USER": "datex_user", "DATEX_PASSWORD": "datex_password", "FROST_CLIENT_ID": "frost_client_id"}


     def parse(argv: list[str] | None) -> argparse.Namespace:
         p = argparse.ArgumentParser(prog="collector", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
         p.add_argument("--source", required=True, nargs="+", choices=SOURCES)
         p.add_argument("--county", type=int, default=55, help="NVDB fylke number; 55 = Troms")
         p.add_argument("--from", dest="date_from", type=date.fromisoformat, help="inclusive, YYYY-MM-DD")
         p.add_argument("--to", dest="date_to", type=date.fromisoformat, help="exclusive, YYYY-MM-DD")
         p.add_argument("--target", choices=TARGETS, default="local")
         p.add_argument("--stations-file", help="frost/elevation: local NVDB stations .jsonl (default: newest under data/landing)")
         return p.parse_args(argv)


     def secrets_from_workspace() -> None:
         """Inside a job task (--target workspace) credentials come from the `frostsight` secret scope."""
         from databricks.sdk import WorkspaceClient

         w = WorkspaceClient()
         for env, key in SECRET_KEYS.items():
             if not os.environ.get(env):
                 os.environ[env] = w.dbutils.secrets.get(scope="frostsight", key=key)


     def collect_one(source: str, a: argparse.Namespace) -> list[str]:
         if source == "nvdb":
             since = a.date_from or date(date.today().year - 5, 1, 1)
             return nvdb.collect(a.county, since, a.target)
         if source == "frost":
             if not (a.date_from and a.date_to):
                 sys.exit("frost needs --from and --to")
             return frost.collect(a.county, a.date_from, a.date_to, a.target, a.stations_file)
         if source in ("road_weather", "road_incidents"):
             return datex.collect(source, a.target)
         if source == "datex_sites":
             return datex.collect_sites(a.target)
         if source == "elevation":
             return elevation.collect(a.county, a.target, a.stations_file)
         return metadata.collect(a.target)


     def main(argv: list[str] | None = None) -> int:
         a = parse(argv)
         logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
         if a.target == "workspace":
             secrets_from_workspace()
         failures = 0
         for source in a.source:
             try:
                 for path in collect_one(source, a):
                     print(path)
             except Exception:  # noqa: BLE001 - one failing source must not stop the others in a cron run
                 logging.getLogger("collector").exception("%s failed", source)
                 failures += 1
         return 1 if failures else 0


     if __name__ == "__main__":
         sys.exit(main())
     ```
     `--source` takes several names so one cron tick pulls road weather and incidents in one process.
     A failing source is logged and the exit code is 1, but the other sources still land their files.
     verify at M4: `WorkspaceClient().dbutils.secrets.get` inside a serverless Python task (the SDK's
     `dbutils` shim; the alternative is `from pyspark.dbutils import DBUtils`).
  3. Create `config/sources.yml` and `collector/metadata.py`. The YAML is the single
     record of endpoints, licences and cadence; `metadata.py` writes it into landing so
     `bronze.source_metadata` (M4) carries the attribution the licences require:
     ```yaml
     # config/sources.yml: every external source the collector touches. Attribution goes to bronze.source_metadata.
     pilot_county: 55
     sources:
       nvdb:
         endpoint: https://nvdbapiles.atlas.vegvesen.no
         auth: header X-Client
         cadence: weekly
         licence: NLOD 2.0
         attribution: "Data from Statens vegvesen (NVDB), NLOD"
       datex_road_weather:
         endpoint: https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetMeasuredWeatherData/pullsnapshotdata
         auth: basic
         cadence: 10 min
         licence: NLOD 2.0
         attribution: "Data from Statens vegvesen (DATEX II), NLOD"
       datex_situations:
         endpoint: https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetSituation/pullsnapshotdata
         auth: basic
         cadence: 10 to 30 min
         licence: NLOD 2.0
         attribution: "Data from Statens vegvesen (DATEX II), NLOD"
       frost:
         endpoint: https://frost.met.no
         auth: client id
         cadence: once (history)
         licence: CC BY 4.0
         attribution: "Data from MET Norway, CC BY 4.0"
       open_meteo_elevation:
         endpoint: https://api.open-meteo.com/v1/elevation
         auth: none
         cadence: once
         licence: CC BY 4.0
         attribution: "Elevation data by Open-Meteo.com (Copernicus GLO-90), CC BY 4.0"
     ```
     ```python
     """Writes config/sources.yml as one JSON line per source into raw/source_metadata/."""

     from __future__ import annotations

     from pathlib import Path

     import yaml

     from collector.common import deliver, landing_path, utc_now, write_jsonl

     CONFIG = Path(__file__).resolve().parents[1] / "config" / "sources.yml"


     def rows(collected_at: str) -> list[dict]:
         cfg = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
         return [{"source": name, **spec, "collected_at": collected_at} for name, spec in cfg["sources"].items()]


     def collect(target: str) -> list[str]:
         ts = utc_now()
         rel = landing_path("source_metadata", ts, "jsonl")
         path, _ = write_jsonl(rel, rows(ts.isoformat()))
         return [deliver(path, rel, target)]
     ```
  4. `cd project && uv run python -m collector.run --help` prints the usage.
Expect: `--help` works; `python -c "from collector.common import landing_path; from datetime import
datetime, timezone; print(landing_path('nvdb_stations', datetime(2026,10,5,9,0,tzinfo=timezone.utc), 'jsonl'))"`
prints `nvdb_stations/2026/10/05/20261005T090000Z.jsonl`.
If it fails:
  - `ModuleNotFoundError: collector`: run from the repo root with `uv run` (the project is installed
    editable by `uv sync`, T0.3), and `python -m` needs the cwd.
  - `ValueError: ts must be timezone-aware UTC`: never pass `datetime.now()`; use `utc_now()`.
  - `ValueError: source is one flat folder name`: a nested name like `nvdb/stations` slipped in; the
    README layout has no nesting.

### T1.3 `nvdb.py` and the NVDB extract      owner: Rayhan
Why: the road graph, station points, speed limits, accidents, slides and counties are all NVDB
behind one client (verification file, finding 4). One module, one pagination loop.
Do:
  1. Create `collector/nvdb.py`:
     ```python
     """NVDB API v4 extracts for one county: road links, stations 153, speed limits 105, accidents 570,
     avalanche and landslide 445, and the county list.

     Facts (probed 28 Sep 2026): the header X-Client is mandatory; pages carry metadata.neste.href,
     which already includes every query parameter; a page with zero objects ends the walk; geometry
     is WKT; the default srid is 5973 (UTM 33 horizontal, NN2000 height). We ask for srid=25833 so the
     landed WKT states the horizontal CRS silver uses (same X/Y as 5973; verify: the srid parameter).
     """

     from __future__ import annotations

     import logging
     import os
     from collections.abc import Iterator
     from datetime import date, datetime

     import requests

     from collector.common import deliver, landing_path, session, utc_now, write_jsonl

     log = logging.getLogger("collector.nvdb")

     BASE = "https://nvdbapiles.atlas.vegvesen.no"
     PAGE_SIZE = 1000
     SRID = 25833
     # landing folder -> NVDB object type
     OBJECT_TYPES = {"nvdb_stations": 153, "nvdb_speed_limits": 105, "nvdb_accidents": 570, "nvdb_avalanche": 445}
     DATE_PROPERTY = {570: 5055}  # Ulykkesdato; 445 (Skred dato, 2324) is not filtered on purpose
     INCLUDE = "lokasjon,geometri,egenskaper,vegsegmenter"


     def nvdb_session() -> requests.Session:
         return session(headers={"X-Client": os.environ.get("NVDB_CLIENT", "frostsight")})


     def iter_pages(s: requests.Session, url: str, params: dict | None) -> Iterator[dict]:
         """Yield objects page by page, following metadata.neste.href until an empty page."""
         while url:
             r = s.get(url, params=params, timeout=180)
             r.raise_for_status()
             body = r.json()
             objects = body.get("objekter", [])
             if not objects:
                 return
             yield from objects
             nxt = body.get("metadata", {}).get("neste")
             url, params = (nxt["href"], None) if nxt else (None, None)


     def iter_objects(s: requests.Session, type_id: int, county: int, since: date | None = None) -> Iterator[dict]:
         params: dict = {"fylke": county, "antall": PAGE_SIZE, "inkluder": INCLUDE, "srid": SRID}
         if since is not None and type_id in DATE_PROPERTY:
             params["egenskap"] = f"{DATE_PROPERTY[type_id]}>={since:%Y-%m-%d}"
         yield from iter_pages(s, f"{BASE}/vegobjekter/{type_id}", params)


     def iter_road_links(s: requests.Session, county: int) -> Iterator[dict]:
         yield from iter_pages(s, f"{BASE}/vegnett/veglenkesekvenser/segmentert",
                               {"fylke": county, "antall": PAGE_SIZE, "srid": SRID})


     def counties(s: requests.Session) -> list[dict]:
         r = s.get(f"{BASE}/omrader/fylker", timeout=60)
         r.raise_for_status()
         return r.json()   # a JSON array of {nummer, navn, ...}; one line each in landing


     def stamp(rows: Iterator[dict], county: int, collected_at: datetime, dataset: str) -> Iterator[dict]:
         """Add the collector metadata bronze will copy into its _ columns."""
         for row in rows:
             row["_county"] = county
             row["_dataset"] = dataset
             row["_collected_at"] = collected_at.isoformat()
             yield row


     def collect(county: int, since: date, target: str, ts: datetime | None = None) -> list[str]:
         ts = ts or utc_now()
         s = nvdb_session()
         datasets: dict[str, Iterator[dict]] = {
             "nvdb_road_network": iter_road_links(s, county),
             "nvdb_counties": iter(counties(s)),
         }
         for name, type_id in OBJECT_TYPES.items():
             datasets[name] = iter_objects(s, type_id, county, since if type_id in DATE_PROPERTY else None)
         delivered: list[str] = []
         for name, rows in datasets.items():
             rel = landing_path(name, ts, "jsonl")
             path, n = write_jsonl(rel, stamp(rows, county, ts, name))
             log.info("%s: %d objects -> %s", name, n, path)
             delivered.append(deliver(path, rel, target))
         return delivered
     ```
     Avalanche and landslide events (445) are not date-filtered on purpose: 5,470 events in Troms is
     small and the history is the point. Accidents (570) are filtered because the dataset is five
     calendar years by policy. `vegsegmenter` is included because the reference job (05_M4) reads the
     speed-limit placement from it. verify: `inkluder=vegsegmenter` is accepted on v4 (the verification
     file probed `lokasjon,geometri,egenskaper` only); drop it if the API answers 400 and note it in T1.7.
  2. Run locally first, then to the team workspace:
     ```bash
     cd project
     uv run --env-file .env python -m collector.run --source nvdb --county 55 --target local
     ls -la data/landing/raw/nvdb_*/2026/*/*/
     uv run --env-file .env python -m collector.run --source nvdb --county 55 --target free
     ```
     The road-links walk is the long one: 1,000 segments per page is about 1.9 MB and 5 to 10 s; the
     county is a few tens of pages. Expect 5 to 15 minutes in total. Do not run five copies in
     parallel; NVDB rate-limits by client.
  3. Coordinate note. NVDB returns `geometri.wkt` such as `POINT(709574 7723529)` or `LINESTRING Z
     (564133.14 7600942.6 203.317, ...)`. EPSG:5973 (the default) is ETRS89 / UTM zone 33N with
     NN2000 heights; its horizontal part is EPSG:25833, which is what we request and what the README
     states. Keep it raw in landing and bronze. Silver (M4) adds WGS84 with pyproj (`frostsight.geo`).
     The snippet silver uses, and that `elevation.py` uses now:
     ```python
     from pyproj import Transformer

     to_wgs84 = Transformer.from_crs("EPSG:25833", "EPSG:4326", always_xy=True)
     lon, lat = to_wgs84.transform(709574.0, 7723529.0)   # -> about (20.377, 69.538)
     ```
     NVDB can also return WGS84 directly with `srid=4326` on the query, but then the WKT is
     `POINT(69.53757762 20.37749136)`: latitude first (probed). Do not use it in the extract; one
     projection in one place (silver) is easier to test.
Expect: six files, one under each of `/Volumes/frostsight/landing/raw/nvdb_road_network/2026/<mm>/<dd>/`,
`nvdb_stations/...`, `nvdb_speed_limits/...`, `nvdb_accidents/...`, `nvdb_avalanche/...`, `nvdb_counties/...`.
Approximate counts for Troms: stations 30, speed limits several thousand, accidents about 480
(since 2021), avalanche and landslide 5,470, road links tens of thousands, counties 15.
If it fails:
  - 400 "X-Client må være satt": header missing; check `.env` is loaded.
  - 400 "Ugyldig avansert filter": the `egenskap` value has a typo; the form is `<property id><op><value>`.
  - 400 on `srid` or `inkluder`: remove the parameter (see step 1), note it in T1.7; silver handles 5973
    identically because X/Y are the same.
  - The walk stops early with the same count every time: `PAGE_SIZE` above the server maximum
    is silently reduced; that is fine. A stop with an exception is a timeout; the retry session
    handles 5xx, and a rerun produces the same file name so nothing is duplicated.

### T1.4 `frost.py` and last winter's observations      owner: Shawon
Why: replay and the demo run on last winter's road-weather observations; DATEX has no history
endpoint. Frost is the history source (verification file, finding 2). The M2 replay harness reads
`frost_history` and the M4 code joins `frost_sources`, so both land as flat JSON lines, not as the
raw JSON-LD.
Do:
  1. First, with your client id, find the element names Frost uses for road-weather stations.
     Element ids are not verified (the elements endpoint returns 401 without a client id):
     ```bash
     set -a; . ./.env; set +a
     curl -s --user "$FROST_CLIENT_ID:" "https://frost.met.no/sources/v0.jsonld?stationholder=STATENS%20VEGVESEN&county=Troms" | python3 -m json.tool | head -60
     # take one id (SNxxxxx) and list what it measures at 10 minutes
     curl -s --user "$FROST_CLIENT_ID:" "https://frost.met.no/observations/availableTimeSeries/v0.jsonld?sources=SN<id>&timeresolutions=PT10M" | python3 -c "import sys,json; print(sorted({d['elementId'] for d in json.load(sys.stdin)['data']}))"
     curl -s --user "$FROST_CLIENT_ID:" "https://frost.met.no/elements/v0.jsonld?ids=air_temperature,road_surface_temperature,surface_temperature,dew_point_temperature,relative_humidity,wind_speed,wind_from_direction" | python3 -m json.tool | grep '"id"'
     ```
     verify: the county filter value (`Troms` versus `55`; Frost documents `county` as a name),
     the availableTimeSeries path, and the exact element ids. Candidates from the Frost element
     table: `air_temperature`, `road_surface_temperature` (or `surface_temperature`),
     `dew_point_temperature`, `relative_humidity`, `wind_speed`, `wind_from_direction`,
     `sum(precipitation_amount PT10M)`, `surface_snow_thickness`. Put the confirmed list into
     `ELEMENTS` below and into the data contract (T1.7).
  2. Create `collector/frost.py`:
     ```python
     """MET Frost: Statens vegvesen station list and 10-minute observations for one county, as JSON lines.

     frost_sources/<ts>.jsonl      one line per Frost source: source_id, name, lat, lon, masl, station_id
     frost_history/<month>_<SN>.jsonl  one line per observation time: station_id, frost_source_id, event_time, elements

     station_id is the NVDB Målestasjonsnummer of the nearest NVDB station within 300 m (same rule as
     silver.road_weather_stations at M4), null when none; the replay harness skips null rows.
     """

     from __future__ import annotations

     import logging
     import math
     import os
     from collections.abc import Iterator
     from datetime import date, datetime, timezone
     from pathlib import Path

     import requests

     from collector.common import deliver, landing_path, session, utc_now, write_jsonl
     from collector.elevation import newest_stations_file, station_points

     log = logging.getLogger("collector.frost")
     BASE = "https://frost.met.no"
     COUNTY_NAMES = {55: "Troms", 34: "Innlandet"}          # verify: Frost county spelling
     ELEMENTS = {                                             # Frost element id -> our field; verify: T1.4 step 1
         "air_temperature": "air_temperature",
         "road_surface_temperature": "road_surface_temperature",
         "dew_point_temperature": "dew_point",
         "relative_humidity": "humidity",
         "wind_speed": "wind_speed",
         "wind_from_direction": "wind_direction",
         "sum(precipitation_amount PT10M)": "precipitation_10min",
     }
     MATCH_M = 300.0


     def frost_session() -> requests.Session:
         return session(auth=(os.environ["FROST_CLIENT_ID"], ""))   # client id is the username, empty password


     def sources(s: requests.Session, county: int) -> list[dict]:
         r = s.get(
             f"{BASE}/sources/v0.jsonld",
             params={"stationholder": "STATENS VEGVESEN", "county": COUNTY_NAMES[county],
                     "fields": "id,name,shortName,geometry,masl,municipality,county,validFrom,validTo,stationHolders,externalIds"},
             timeout=60,
         )
         r.raise_for_status()
         return r.json()["data"]


     def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
         p = math.pi / 180
         a = (math.sin((lat2 - lat1) * p / 2) ** 2
              + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
         return 2 * 6371000 * math.asin(math.sqrt(a))


     def nearest_station(lat: float, lon: float, nvdb: list[dict]) -> str | None:
         best = min(nvdb, key=lambda p: haversine_m(lat, lon, p["lat"], p["lon"]), default=None)
         if best is None or haversine_m(lat, lon, best["lat"], best["lon"]) > MATCH_M:
             return None
         return best["station_id"]


     def flatten_sources(srcs: list[dict], nvdb: list[dict]) -> Iterator[dict]:
         for src in srcs:
             coords = (src.get("geometry") or {}).get("coordinates") or [None, None]   # Frost: [lon, lat]
             lon, lat = coords[0], coords[1]
             yield {
                 "source_id": src["id"], "name": src.get("name"), "lat": lat, "lon": lon, "masl": src.get("masl"),
                 "valid_from": src.get("validFrom"), "valid_to": src.get("validTo"),
                 "external_ids": src.get("externalIds"),
                 "station_id": nearest_station(lat, lon, nvdb) if lat is not None else None,
             }


     def month_windows(start: date, end: date) -> Iterator[tuple[date, date]]:
         """[start, end) split at month boundaries; Frost limits rows per call, a month per station is safe."""
         cur = start
         while cur < end:
             nxt = date(cur.year + (cur.month == 12), (cur.month % 12) + 1, 1)
             yield cur, min(nxt, end)
             cur = nxt


     def observations(s: requests.Session, source_id: str, start: date, end: date) -> list[dict] | None:
         r = s.get(
             f"{BASE}/observations/v0.jsonld",
             params={"sources": source_id, "elements": ",".join(ELEMENTS),
                     "referencetime": f"{start:%Y-%m-%d}/{end:%Y-%m-%d}",
                     "timeresolutions": "PT10M", "timeoffsets": "default", "levels": "default"},
             timeout=300,
         )
         if r.status_code == 412:            # Frost: "no data found for this combination"; verify code
             return None
         r.raise_for_status()
         return r.json()["data"]


     def flatten_observations(data: list[dict], station_id: str | None) -> Iterator[dict]:
         """One line per reference time with the elements as columns, event_time in UTC ISO."""
         for rec in data:
             t = datetime.fromisoformat(rec["referenceTime"].replace("Z", "+00:00")).astimezone(timezone.utc)
             row = {"station_id": station_id, "frost_source_id": rec["sourceId"].split(":")[0],
                    "event_time": t.strftime("%Y-%m-%dT%H:%M:%SZ")}
             for ob in rec.get("observations", []):
                 field = ELEMENTS.get(ob["elementId"])
                 if field:
                     row[field] = ob.get("value")
                     row[f"{field}_unit"] = ob.get("unit")
             yield row


     def collect(county: int, date_from: date, date_to: date, target: str, stations_file: str | None = None) -> list[str]:
         s = frost_session()
         ts = utc_now()
         out: list[str] = []
         nvdb = station_points(Path(stations_file) if stations_file else newest_stations_file())
         srcs = list(flatten_sources(sources(s, county), nvdb))
         rel = landing_path("frost_sources", ts, "jsonl", suffix=f"_fylke{county}")
         path, n = write_jsonl(rel, iter(srcs))
         out.append(deliver(path, rel, target))
         log.info("%d Statens vegvesen sources in county %d, %d matched to an NVDB station",
                  n, county, sum(1 for x in srcs if x["station_id"]))
         for src in srcs:
             for m0, m1 in month_windows(date_from, date_to):
                 data = observations(s, src["source_id"], m0, m1)
                 if not data:
                     continue
                 file_ts = datetime(m0.year, m0.month, m0.day, tzinfo=timezone.utc)
                 rel = landing_path("frost_history", file_ts, "jsonl", suffix=f"_{src['source_id']}")
                 path, n = write_jsonl(rel, flatten_observations(data, src["station_id"]))
                 log.info("%s %s: %d rows", src["source_id"], f"{m0:%Y-%m}", n)
                 out.append(deliver(path, rel, target))
         return out
     ```
     The file timestamp is the month start, not the collection time, so a re-run of the same window
     produces the same names. The raw JSON-LD is not kept: the flattened line carries every value and
     unit; the T1.9 unit test feeds the M0 fixture through `flatten_observations`.
  3. Run for last winter (needs the NVDB stations file from T1.3, local or `--stations-file`):
     ```bash
     uv run --env-file .env python -m collector.run --source frost --county 55 --from 2025-11-01 --to 2026-04-01 --target free
     ```
     About 30 stations times 5 months = up to 150 requests. Frost allows a few requests per
     second; the retry session backs off on 429.
Expect: `frost_sources/2026/<mm>/<dd>/<ts>_fylke55.jsonl` with 20 to 40 lines, most with a
`station_id`; up to 150 files under `frost_history/2025/11/01/`, `2025/12/01/`, ... `2026/03/01/`,
each 0.5 to 2 MB, about 4,464 lines per station-month.
If it fails:
  - 401: client id wrong or `.env` not loaded.
  - 400 with "elements not found": a name in `ELEMENTS` is wrong; step 1 was skipped.
  - 412 on every station: the county filter matched nothing at PT10M; try without
    `timeresolutions`, or the stations report at PT1H only. Record the real resolution in the contract.
  - 403 "too many observations": the window is too large; split months into halves.
  - `FileNotFoundError: run --source nvdb --target local first`: the stations file is missing; run T1.3
    locally or pass `--stations-file`.
  - Few `station_id` matches: Frost and NVDB place the same station up to a few hundred metres apart;
    raise `MATCH_M` to 500 and record the choice in T1.7.

### T1.5 `datex.py`: contract v1, first snapshot pair, site table      owner: Shawon
Why: bronze (M4) reads flat JSON lines with `cloudFiles.format = json`, so the collector, not the
pipeline, parses the DATEX II XML. One parser in Python, unit-tested on the M0 fixture. The raw XML
is kept beside it. The 10-minute cron starts at M2; M1 lands one pair by hand and fixes the contract.

Contract v1, one object per line (this is the contract `05_M4` section 1 repeats; change it only
here, and bump `schema_version`):

```json
{"schema_version": "1", "source_event_id": "SVV-1900177-2026-11-03T07:10:00Z",
 "station_ref": "1900177", "site_id": "SVV.1900177", "measurement_time": "2026-11-03T07:10:00Z",
 "air_temperature": -3.2, "road_surface_temperature": -4.1, "dew_point": -3.8, "humidity": 96.0,
 "temperature_unit": "C", "precipitation_type": "snow", "precipitation_intensity": 0.4,
 "precipitation_unit": "mm/h", "wind_speed": 3.1, "wind_speed_unit": "m/s", "wind_direction": 210.0,
 "road_surface_state": "wet"}
```

Incident lines (`road_incidents/`) carry `schema_version, source_event_id, incident_id, version,
incident_type, severity, road_ref, start_time, end_time, description, lat, lon, snapshot_time`, with
`incident_type` in `CLOSURE, ACCIDENT, ROADWORK, WEATHER, OBSTRUCTION, OTHER` and `severity` in
`HIGH, MEDIUM, LOW, UNKNOWN`. `station_ref` is the NVDB `Målestasjonsnummer`; it is the silver
`station_id`. Missing values are `null`, never omitted, so Auto Loader sees a stable schema.

Do:
  1. Create `collector/datex.py`. Element names are the usual DATEX II v3 ones; the parser
     matches on local names (namespace-agnostic) and every name below is "verify: against the landed
     XML" (step 3):
     ```python
     """DATEX II pull snapshots from Statens vegvesen: raw XML kept as-is, plus flat JSON lines (contract v1)."""

     from __future__ import annotations

     import logging
     import os
     import re
     import xml.etree.ElementTree as ET
     from collections.abc import Iterator
     from datetime import datetime

     from collector.common import deliver, landing_path, session, utc_now, write_bytes, write_jsonl

     log = logging.getLogger("collector.datex")
     BASE = "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi"
     ENDPOINTS = {"road_weather": "GetMeasuredWeatherData", "road_incidents": "GetSituation",
                  "datex_sites": "GetMeasurementWeatherSiteTable"}
     SCHEMA_VERSION = "1"
     STATION_NUMBER = re.compile(r"(\d{5,})\s*$")        # NVDB Målestasjonsnummer at the end of the site id; verify
     # DATEX situationRecord xsi:type (local name) -> contract incident_type; verify against the landed XML
     INCIDENT_TYPES = {
         "RoadOrCarriagewayOrLaneManagement": "CLOSURE", "Accident": "ACCIDENT",
         "MaintenanceWorks": "ROADWORK", "ConstructionWorks": "ROADWORK",
         "PoorEnvironmentConditions": "WEATHER", "WeatherRelatedRoadConditions": "WEATHER",
         "GeneralObstruction": "OBSTRUCTION", "AnimalPresenceObstruction": "OBSTRUCTION",
         "VehicleObstruction": "OBSTRUCTION", "EnvironmentalObstruction": "OBSTRUCTION",
     }
     SEVERITY = {"highest": "HIGH", "high": "HIGH", "medium": "MEDIUM", "low": "LOW", "lowest": "LOW"}
     # measured-value local names -> contract fields (numeric); verify against the landed XML
     WEATHER_VALUES = {
         "airTemperature": "air_temperature", "roadSurfaceTemperature": "road_surface_temperature",
         "dewPointTemperature": "dew_point", "relativeHumidity": "humidity",
         "precipitationIntensity": "precipitation_intensity", "windSpeed": "wind_speed",
         "windDirectionBearing": "wind_direction",
     }
     WEATHER_TEXTS = {"precipitationType": "precipitation_type", "weatherRelatedRoadConditionType": "road_surface_state"}
     WEATHER_FIELDS = ("air_temperature", "road_surface_temperature", "dew_point", "humidity", "precipitation_type",
                       "precipitation_intensity", "wind_speed", "wind_direction", "road_surface_state")


     def local(tag: str) -> str:
         return tag.rsplit("}", 1)[-1]


     def iter_local(el: ET.Element, name: str) -> Iterator[ET.Element]:
         return (e for e in el.iter() if local(e.tag) == name)


     def first_text(el: ET.Element, name: str) -> str | None:
         for e in iter_local(el, name):
             if e.text and e.text.strip():
                 return e.text.strip()
         return None


     def as_float(text: str | None) -> float | None:
         try:
             return None if text is None else float(text)
         except ValueError:
             return None


     def xsi_type(el: ET.Element) -> str:
         return (el.get("{http://www.w3.org/2001/XMLSchema-instance}type") or "").split(":")[-1]


     def fetch(source: str) -> bytes:
         s = session(auth=(os.environ["DATEX_USER"], os.environ["DATEX_PASSWORD"]), headers={"Accept": "application/xml"})
         r = s.get(f"{BASE}/{ENDPOINTS[source]}/pullsnapshotdata", timeout=120)
         r.raise_for_status()
         if not r.content.lstrip().startswith(b"<"):
             raise RuntimeError(f"{source}: response is not XML: {r.content[:80]!r}")
         return r.content


     def parse_weather(xml: bytes) -> Iterator[dict]:
         """One line per site and measurement time."""
         root = ET.fromstring(xml)
         for site in iter_local(root, "siteMeasurements"):
             ref = next(iter_local(site, "measurementSiteReference"), None)
             site_id = (ref.get("id") if ref is not None else None) or first_text(site, "measurementSiteReference")
             t = first_text(site, "measurementTimeDefault")
             m = STATION_NUMBER.search(site_id or "")
             row = {"schema_version": SCHEMA_VERSION, "source_event_id": f"SVV-{site_id}-{t}",
                    "station_ref": m.group(1) if m else None, "site_id": site_id, "measurement_time": t}
             row.update({f: None for f in WEATHER_FIELDS})
             for el in site.iter():
                 name = local(el.tag)
                 if name in WEATHER_VALUES:
                     row[WEATHER_VALUES[name]] = as_float(first_text(el, "value") or el.text)
                 elif name in WEATHER_TEXTS:
                     row[WEATHER_TEXTS[name]] = (el.text or "").strip().lower() or None
             row.update({"temperature_unit": "C", "precipitation_unit": "mm/h", "wind_speed_unit": "m/s"})
             yield row


     def parse_situations(xml: bytes, snapshot_time: str) -> Iterator[dict]:
         """One line per situationRecord: the current version of each record in this snapshot."""
         root = ET.fromstring(xml)
         for rec in iter_local(root, "situationRecord"):
             rec_id, version = rec.get("id"), rec.get("version")
             sev = (first_text(rec, "severity") or "").lower()
             yield {
                 "schema_version": SCHEMA_VERSION,
                 "source_event_id": f"{rec_id}:{version}",
                 "incident_id": rec_id,
                 "version": int(version) if version and version.isdigit() else None,
                 "incident_type": INCIDENT_TYPES.get(xsi_type(rec), "OTHER"),
                 "severity": SEVERITY.get(sev, "UNKNOWN"),
                 "road_ref": first_text(rec, "roadNumber"),
                 "start_time": first_text(rec, "overallStartTime"),
                 "end_time": first_text(rec, "overallEndTime"),
                 "description": first_text(rec, "value"),           # generalPublicComment/comment/values/value
                 "lat": as_float(first_text(rec, "latitude")),
                 "lon": as_float(first_text(rec, "longitude")),
                 "snapshot_time": snapshot_time,
             }


     def parse_sites(xml: bytes) -> Iterator[dict]:
         root = ET.fromstring(xml)
         for site in iter_local(root, "measurementSiteRecord"):
             yield {"site_id": site.get("id"), "name": first_text(site, "value"),
                    "lat": as_float(first_text(site, "latitude")), "lon": as_float(first_text(site, "longitude"))}


     def collect(source: str, target: str, ts: datetime | None = None) -> list[str]:
         """Land <source>_xml/<ts>.xml (raw) and <source>/<ts>.jsonl (contract v1)."""
         ts = ts or utc_now()
         body = fetch(source)
         xml_rel = landing_path(f"{source}_xml", ts, "xml")
         out = [deliver(write_bytes(xml_rel, body), xml_rel, target)]
         rows = parse_weather(body) if source == "road_weather" else parse_situations(body, ts.strftime("%Y-%m-%dT%H:%M:%SZ"))
         rel = landing_path(source, ts, "jsonl")
         path, n = write_jsonl(rel, rows)
         log.info("%s: %d bytes xml, %d lines", source, len(body), n)
         if n == 0:
             raise RuntimeError(f"{source}: parsed zero records; the element names in datex.py need checking against {xml_rel}")
         out.append(deliver(path, rel, target))
         return out


     def collect_sites(target: str) -> list[str]:
         ts = utc_now()
         body = fetch("datex_sites")
         rel = landing_path("datex_sites", ts, "jsonl")
         path, n = write_jsonl(rel, parse_sites(body))
         log.info("datex_sites: %d sites", n)
         return [deliver(path, rel, target)]
     ```
  2. Run all three, once credentials exist:
     ```bash
     uv run --env-file .env python -m collector.run --source road_weather road_incidents datex_sites --target free
     ```
  3. Open the landed XML (`road_weather_xml/...`) and confirm, one by one: the element that carries the
     site id (`measurementSiteReference@id`), the time (`measurementTimeDefault`), the measured value
     names (`WEATHER_VALUES`, `WEATHER_TEXTS`), the record types and severities in situations, and
     whether the site id ends with the NVDB `Målestasjonsnummer`. Fix the dictionaries, re-run, and
     record the confirmed names in T1.7. If the site id does not carry the station number,
     `station_ref` is filled at M4 from `datex_sites` by nearest point (`silver.road_weather_stations.datex_site_id`)
     and the collector leaves it null; say so in T1.7.
  4. Unit test now, on the trimmed M0 fixtures: `parse_weather(open("tests/fixtures/datex_measured_weather.xml","rb").read())`
     yields three rows with a `measurement_time` and at least one temperature; `parse_situations` yields
     rows with `incident_id` and `version`. Add both to T1.9's test file.
Expect: `road_weather_xml/2026/<mm>/<dd>/<ts>.xml` around 1 to 2 MB, `road_weather/.../<ts>.jsonl` with
one line per station in the national snapshot (a few hundred; silver filters to the county through the
station table), and the same pair under `road_incidents_xml/` and `road_incidents/`;
`datex_sites/.../<ts>.jsonl` with one line per site.
If it fails:
  - 401 from the collector host but 200 from a laptop: the IP allow-list is enforced (T0.4). Run
    from the static-IP host.
  - `parsed zero records`: the local names differ from the guesses; open the XML and fix the
    dictionaries. The raw XML is landed before parsing, so nothing is lost.
  - A gzip body that is not XML: requests decodes `Content-Encoding` automatically; if the server
    returns a zip file instead, note it and unzip in `fetch()`.

### T1.6 `elevation.py` for station points      owner: Rayhan
Why: Kartverket was unreachable at verification; Open-Meteo elevation is the fallback, and the Z
coordinate in NVDB geometry is the cross-check (verification file, finding 3). `station_points` is
also what `frost.py` uses to map Frost sources to NVDB stations.
Do:
  1. Create `collector/elevation.py`:
     ```python
     """Open-Meteo elevation for NVDB station points. Max 100 coordinates per request (Open-Meteo docs)."""

     from __future__ import annotations

     import json
     import logging
     import re
     from pathlib import Path

     from pyproj import Transformer

     from collector.common import LOCAL_ROOT, deliver, landing_path, session, utc_now, write_jsonl

     log = logging.getLogger("collector.elevation")
     URL = "https://api.open-meteo.com/v1/elevation"
     STATION_NUMBER_PROPERTY = 3591            # Målestasjonsnummer
     WKT_POINT = re.compile(r"POINT\s*Z?\s*\(\s*([-\d.]+)\s+([-\d.]+)")
     to_wgs84 = Transformer.from_crs("EPSG:25833", "EPSG:4326", always_xy=True)


     def station_points(stations_jsonl: Path) -> list[dict]:
         """(station_id, nvdb_id, lat, lon) from a landed nvdb_stations file. The only projection in the collector."""
         points = []
         for line in stations_jsonl.read_text(encoding="utf-8").splitlines():
             obj = json.loads(line)
             m = WKT_POINT.match((obj.get("geometri") or {}).get("wkt") or "")
             if not m:
                 log.warning("station %s has no point geometry; skipped", obj.get("id"))
                 continue
             east, north = float(m.group(1)), float(m.group(2))
             lon, lat = to_wgs84.transform(east, north)
             props = {p["id"]: p.get("verdi") for p in obj.get("egenskaper", [])}
             points.append({"station_id": str(props.get(STATION_NUMBER_PROPERTY)), "nvdb_id": obj["id"],
                            "lat": round(lat, 6), "lon": round(lon, 6)})
         return points


     def fetch(points: list[dict]) -> list[dict]:
         s = session()
         for i in range(0, len(points), 100):
             batch = points[i : i + 100]
             r = s.get(URL, params={"latitude": ",".join(str(p["lat"]) for p in batch),
                                    "longitude": ",".join(str(p["lon"]) for p in batch)}, timeout=60)
             r.raise_for_status()
             for p, z in zip(batch, r.json()["elevation"], strict=True):
                 p["elevation_m"] = z
                 p["source"] = "open-meteo GLO-90"
         return points


     def newest_stations_file() -> Path:
         files = sorted((LOCAL_ROOT / "nvdb_stations").rglob("*.jsonl"))
         if not files:
             raise FileNotFoundError("run --source nvdb --target local first, or pass --stations-file")
         return files[-1]


     def collect(county: int, target: str, stations_file: str | None = None) -> list[str]:
         points = fetch(station_points(Path(stations_file) if stations_file else newest_stations_file()))
         ts = utc_now()
         rel = landing_path("elevation", ts, "jsonl", suffix=f"_fylke{county}")
         path, n = write_jsonl(rel, iter(points))
         log.info("elevation for %d stations", n)
         return [deliver(path, rel, target)]
     ```
  2. `uv run --env-file .env python -m collector.run --source elevation --county 55 --target free`.
  3. Sanity check: the Nordnes station (`Målestasjonsnummer` 1900177, NVDB point `POINT(709574
     7723529)`) is at sea level on the E6; Open-Meteo should return a single-digit or low
     double-digit metre value. Compare against the NVDB Z where the geometry has one.
Expect: `elevation/2026/<mm>/<dd>/<ts>_fylke55.jsonl` with one row per station and `elevation_m`.
If it fails:
  - A station is skipped with a warning: it has line geometry or no geometry; fine, note it in T1.7.
  - Elevation wildly off: `always_xy=True` was dropped and lat/lon swapped.

### T1.7 Data contracts      owner: Rayhan (NVDB, elevation), Shawon (Frost, DATEX)
Why: bronze and silver (M4) are written against these fields. Unknowns are filled from the landed
files, not guessed. Put the tables into `docs/contracts/landing.md`.
Do: for each source, keep the table below, replace every "confirm from fixture" after reading the
real file, and add the file size and row count observed.

NVDB, common shape (probed): each object has `id`, `href`, `egenskaper` (list of `{id, navn, verdi, ...}`),
`geometri` (`{wkt, srid, egengeometri}`), `lokasjon` (`kommuner`, `fylker`, `vegsystemreferanser`,
`stedfestinger`, ...). Property ids are stable; names are Norwegian. The reference job (05_M4) reads
properties by `navn` (`filter(egenskaper, e -> e.navn = 'Målestasjonsnummer')`), so record both id and
name.

| Dataset | Field we rely on | Where | Type | Notes |
|---|---|---|---|---|
| nvdb_road_network | `veglenkesekvensid`, `veglenkenummer`, `segmentnummer`, `referanse` | top level | int, int, int, string | `road_segment_id` = `<veglenkesekvensid>-<veglenkenummer>-<segmentnummer>` (05_M4 builds it with `concat_ws('-')`); `referanse` like `853767-1-2` should equal it, confirm from fixture |
| nvdb_road_network | `startposisjon`, `sluttposisjon`, `lengde` | top level | float | metres for `lengde` |
| nvdb_road_network | `geometri.wkt`, `geometri.srid` | nested | WKT LINESTRING Z, 25833 (5973 if `srid` was dropped) | keep raw; silver projects to WGS84 |
| nvdb_road_network | `vegsystemreferanse.vegsystem.vegkategori`, `.nummer`, `vegsystemreferanse.strekning.fra_meter`, `.til_meter` | nested | E/R/F/K/P/S, int, float | road class for the priority list; confirm from fixture (05_M4 reads exactly these paths) |
| nvdb_road_network | `typeVeg`, `detaljnivå`, `fylke`, `kommune` | top level | string, string, int, int | filter `detaljnivå = "Vegtrase og kjørebane"` verify: which levels to keep |
| nvdb_stations (153) | `egenskaper[3591]` Målestasjonsnummer | property | int, stored as string | README `station_id`, e.g. `1900177` |
| nvdb_stations (153) | `egenskaper[1083]` Navn, `[11179]` Status, `[8003]` Eier | property | string | keep `Status = Operativ` in silver |
| nvdb_stations (153) | `geometri.wkt` | nested | POINT, 25833 | station point |
| nvdb_stations (153) | `lokasjon.stedfestinger[0].veglenkesekvensid`, `.relativPosisjon` | nested | int, float | NVDB's own link placement; the M3 mapping benchmark compares it against H3 nearest |
| nvdb_speed_limits (105) | `egenskaper[2021]` Fartsgrense, `[5127]` Gyldig fra dato | property | int km/h, date | |
| nvdb_speed_limits (105) | `vegsegmenter[]` (`veglenkesekvensid`, `startposisjon`, `sluttposisjon`) | top level | linear reference | 05_M4 explodes `vegsegmenter`; confirm the array is present with `inkluder=vegsegmenter` |
| nvdb_accidents (570) | `egenskaper[5055]` Ulykkesdato, `[5056]` Ulykkesklokkeslett | property | date, time | event time = date + time, Europe/Oslo, to UTC in silver |
| nvdb_accidents (570) | `[5074]` Alvorlighetsgrad, `[5066]` Ulykkeskode, `[11908]` Ulykkestype (Ny) | property | enum text | severity and type; 05_M4 reads `Alvorligste skadegrad`: confirm which `navn` exists |
| nvdb_accidents (570) | `[5078]` Føreforhold, `[5079]` Værforhold, `[5080]` Lysforhold, `[5086]` Temperatur | property | enum text, int | road and weather conditions at the time |
| nvdb_accidents (570) | `[5070]`..`[5073]` killed, very serious, serious, slight | property | int | |
| nvdb_accidents (570) | `geometri.wkt`, `lokasjon.stedfestinger[0]` | nested | POINT, link ref | |
| nvdb_avalanche (445) | `[2324]` Skred dato, `[2325]` Skred klokkeslett | property | date, int hhmm (`1700`) | probed |
| nvdb_avalanche (445) | `[2326]` Type skred, `[2328]` Løsneområde, `[11320]` Antatt hovedårsak | property | enum text | `Snø`, `Stein`, ... |
| nvdb_avalanche (445) | `[2344]` Stengning, `[2341]` Blokkert veglengde, `[2327]` Volum av skredmasser på veg | property | enum text | road impact; 05_M4 reads `Skade på veg`: confirm the `navn` |
| nvdb_avalanche (445) | `[2339]` Værforhold på vegen, `[5153]` Temperatur på veg | property | enum text, float | |
| nvdb_avalanche (445) | `geometri.wkt` | nested | POINT or LINESTRING Z | both occur (probed) |
| nvdb_counties | `nummer`, `navn` | top level | int, string | 15 rows; 05_M4 `bronze.admin_boundaries_raw` keys on `nummer` |

Frost (verify every row against one `frost_sources` line and one `frost_history` file):

| Dataset | Field | Notes |
|---|---|---|
| frost_sources | `source_id` (`SNxxxxx`), `name`, `lat`, `lon`, `masl`, `valid_from`, `valid_to`, `external_ids`, `station_id` | `station_id` = nearest NVDB station within 300 m, null if none; 05_M4 re-derives the match from `lat`/`lon` |
| frost_history | `station_id`, `frost_source_id`, `event_time` | `event_time` UTC ISO `...Z`; one line per reference time |
| frost_history | `air_temperature`, `road_surface_temperature`, `dew_point`, `humidity`, `wind_speed`, `wind_direction`, `precipitation_10min`, each with `<field>_unit` | element ids from T1.4 step 1; units expected degC, percent, m/s, degrees, mm per 10 min (the harness sends `precipitation_unit: mm/10min`; silver converts) |

DATEX II (fill from the landed XML; confirm every element name):

| Dataset | Element | Contract field | Notes |
|---|---|---|---|
| road_weather | `measurementSiteReference@id` | `site_id`, `station_ref` | confirm whether the id ends with the `Målestasjonsnummer` |
| road_weather | `measurementTimeDefault` | `measurement_time` | ISO with offset; silver converts to UTC |
| road_weather | `airTemperature`, `roadSurfaceTemperature`, `dewPointTemperature`, `relativeHumidity`, `precipitationIntensity`, `precipitationType`, `windSpeed`, `windDirectionBearing`, `weatherRelatedRoadConditionType` | the nine measured fields | inside `physicalQuantity`/`basicData`; names confirm from fixture; units: DATEX v3 uses Celsius, mm/h, m/s (confirm) |
| road_incidents | `situationRecord@id`, `@version`, `situationRecordCreationTime`, `situationRecordVersionTime` | `incident_id`, `version`, `source_event_id` = `id:version` | |
| road_incidents | record `xsi:type`, `validity/overallStartTime`, `overallEndTime`, `severity`, `locationReference` (`roadNumber`, first `latitude`/`longitude`), `generalPublicComment` | `incident_type`, `start_time`, `end_time`, `severity`, `road_ref`, `lat`, `lon`, `description` | closures, accidents, roadworks, weather |
| datex_sites | `measurementSiteRecord@id`, name, `latitude`/`longitude` | `site_id`, `name`, `lat`, `lon` | joins DATEX sites to NVDB stations at M4 |

Elevation: `station_id`, `nvdb_id`, `lat`, `lon`, `elevation_m`, `source`. Confirmed by the code above.
Source metadata: `source`, `endpoint`, `auth`, `cadence`, `licence`, `attribution`, `collected_at`.

Expect: `docs/contracts/landing.md` merged with zero "confirm from fixture" left for
NVDB and elevation; Frost and DATEX rows filled or marked "blocked: no credentials" with a date.
If it fails: a property id is absent on real objects (optional properties are simply missing from
`egenskaper`); treat every property as nullable in bronze.

### T1.8 Replay storm days      owner: Shawon
Why: the demo and S1 replay need two or three real storm days. Pick them from the data, not from
memory: the largest surface-temperature drop with precipitation in the same six hours.
Do:
  1. With the Frost files local (`--target local` or `databricks fs cp -r dbfs:/Volumes/frostsight/landing/raw/frost_history data/landing/raw/frost_history --profile frostsight-free`), run:
     ```python
     import json
     from pathlib import Path

     import pandas as pd

     SURFACE = "road_surface_temperature"            # contract field (T1.7), filled from the element confirmed at T1.4
     PRECIP = "precipitation_10min"

     rows = []
     for f in Path("data/landing/raw/frost_history").rglob("*.jsonl"):
         for line in f.read_text(encoding="utf-8").splitlines():
             r = json.loads(line)
             rows.append((r["frost_source_id"], r["event_time"], r.get(SURFACE), r.get(PRECIP)))
     wide = pd.DataFrame(rows, columns=["station", "time", SURFACE, PRECIP])
     wide["time"] = pd.to_datetime(wide["time"], utc=True)

     def per_station(g: pd.DataFrame) -> pd.DataFrame:
         g = g.set_index("time").sort_index()
         drop6h = g[SURFACE] - g[SURFACE].rolling("6h").max()      # negative = cooling
         precip6h = g[PRECIP].rolling("6h").sum()
         return pd.DataFrame({"drop6h": drop6h, "precip6h": precip6h})

     scored = wide.groupby("station", group_keys=True).apply(per_station).reset_index()
     scored["day"] = scored["time"].dt.date
     daily = (scored[scored["precip6h"] > 1.0]
              .groupby("day").agg(worst_drop=("drop6h", "min"), stations=("station", "nunique"), precip=("precip6h", "max"))
              .sort_values("worst_drop"))
     print(daily.head(10))
     ```
  2. Choose two or three days that are at least a week apart, with `stations >= 5` (the storm hit
     the county, not one sensor), and write `config/replay_events.yml`. This file is read by
     `replay/harness.py` (M2) and by the demo; the harness finds the history files by date, so no
     path or glob is needed here:
     ```yaml
     # Storm days selected at M1 from Frost data; used by replay/harness.py and the demo.
     pilot_county: 55
     events:
       - id: storm_2025_12_xx
         label: "Troms, xx Dec 2025, freezing rain then snow"
         start: "2025-12-xxT00:00:00Z"
         end:   "2025-12-xxT23:59:59Z"
         why: "surface temperature fell N degC in 6 h with M mm precipitation at K stations; S slides, A accidents"
       - id: storm_2026_01_xx
         label: "Troms, xx Jan 2026, rapid surface drop"
         start: "2026-01-xxT00:00:00Z"
         end:   "2026-01-xxT23:59:59Z"
         why: "..."
     ```
  3. Cross-check each day against NVDB avalanche events (`Skred dato`) and accidents (`Ulykkesdato`)
     in the landed files; note the counts in `why`. Days with slides make the better demo.
Expect: the YAML with two or three events and a printed table pasted into the PR.
If it fails:
  - `KeyError` or all-null `road_surface_temperature`: the element mapping in `frost.py` `ELEMENTS`
    is wrong; fix T1.4 step 1 first.
  - Everything is one December week: widen to March, which has freeze-thaw days.

### T1.9 Backfill, idempotency and unit tests      owner: Shawon
Why: re-running the collector must never create duplicate rows downstream. The mechanism is the
file name, and it has to be understood before M4 writes Auto Loader.
Do:
  1. Write the rule into `collector/README.md`:
     - A landing file name is a pure function of (source, timestamp, suffix). Snapshot sources
       (DATEX, NVDB, elevation, metadata) use the collection time, so each cron tick makes a new file
       and a manual re-run at a later minute makes another; both are valid snapshots and bronze keeps
       both, keyed by `_source_file`; silver deduplicates on `(station_id, event_time)`. Window
       sources (Frost) use the window start, so re-running the same window overwrites the same file.
     - `_batch_id` is never written by the collector. Bronze derives it from the file name: the
       timestamp stem for live files, `replay:<event_id>` for `replay__<event_id>__<ts>__r<run start>.jsonl` files
       (README section 4; code in 05_M4 `transforms.batch_id_from_path`).
     - Auto Loader (M4) records every processed file path in its checkpoint and never reads a path
       twice. An overwritten Frost file with the same name is therefore ignored by a stream, which
       is exactly the "no duplicates" guarantee; to force reprocessing, land a new name (new
       timestamp) or run a full refresh. Setting `cloudFiles.allowOverwrites` is not planned.
       `frost_history` itself is never read by Auto Loader; the replay harness turns it into
       `road_weather` files.
     - Backfill = run the collector with `--from/--to` over the gap; the batch reference job (M4)
       reads whole folders with `spark.read.json` and keeps the newest extract day, then `MERGE`s on
       the natural key, so re-landing a month is safe.
  2. Unit tests on the M0 fixtures, `tests/unit/test_collector.py`: `landing_path`
     formatting, the UTC guard and the flat-folder guard; `nvdb.iter_pages` on a fake session that
     serves two pages then an empty one; `elevation.station_points` on
     `tests/fixtures/nvdb_153_stations.json` (convert the fixture's `objekter` to one line per object
     first); `frost.month_windows(2025-11-01, 2026-04-01)` yields five windows;
     `frost.flatten_observations` on `tests/fixtures/frost_observations.json` yields rows with
     `event_time` ending in `Z`; `datex.parse_weather` and `datex.parse_situations` on the trimmed
     M0 fixtures (T1.5 step 4).
  3. `uv run ruff check collector tests && uv run pytest -q tests/unit`.
Expect: tests pass offline; README section present.
If it fails: a test hits the network, which means a function is not pure; inject the session.

## Volume sizes for Troms

| Dataset | Files | Size estimate | Basis |
|---|---|---|---|
| nvdb_road_network | 1 | 60 to 150 MB | 1,000 segments = 1.9 MB (probed); county has tens of thousands of segments |
| nvdb_stations | 1 | 0.07 MB | 30 stations = 66 KB (probed) |
| nvdb_speed_limits | 1 | 10 to 40 MB | thousands of objects with line geometry |
| nvdb_accidents | 1 | 1 to 2 MB | 483 objects since 2021, about 3 KB each |
| nvdb_avalanche | 1 | 15 to 25 MB | 5,470 objects, some with line geometry |
| frost_history | up to 150 | 0.1 to 0.3 GB | 4,464 lines per station-month, about 300 bytes each after flattening |
| road_weather + road_incidents (jsonl) | 2 at M1; 4,300 per month from M2 | 0.1 to 0.3 MB per file; 0.5 to 1.5 GB per month | a few hundred stations per national snapshot |
| road_weather_xml + road_incidents_xml | same count | 0.5 to 2 MB per file; 4 to 8 GB per month | verification file storage estimate; M7 retention deletes XML older than 30 days |
| elevation, datex_sites, source_metadata, nvdb_counties | 1 each | < 0.1 MB | |
| **Total at M1** | | **about 0.2 to 0.5 GB** | the live DATEX stream is the growth line, handled at M2 by a 20 to 30 min cadence on Free and by retention in M7 |

## Done when

- `collector/` has `common.py`, `nvdb.py`, `frost.py`, `datex.py`, `elevation.py`, `metadata.py`,
  `run.py` and a README; `python -m collector.run --help` works; unit tests pass offline.
- `sql/001_catalog_schemas_volume.sql` merged and run on the team workspace and in every
  personal workspace.
- The team volume holds the six NVDB files, the Frost sources file and last winter's history files
  for the county, one elevation file, one source-metadata file, and (credentials permitting) one DATEX
  snapshot pair (xml + jsonl) plus the site table.
- `docs/contracts/landing.md` is merged; contract v1 for road weather and incidents is fixed.
- `config/sources.yml` and `config/replay_events.yml` (two or three storm days with reasons) merged.
- ADR 0004 updated with the Statens vegvesen answer on the fixed IP, if it arrived.

## Verify

```bash
P=frostsight-free
# catalog and volume
databricks schemas list frostsight --profile $P                 # landing, bronze, silver, gold, quarantine, ml
databricks fs ls dbfs:/Volumes/frostsight/landing/raw/ --profile $P
for d in nvdb_road_network nvdb_stations nvdb_speed_limits nvdb_accidents nvdb_avalanche nvdb_counties; do
  echo "== $d"; databricks fs ls -l dbfs:/Volumes/frostsight/landing/raw/$d/2026/ --profile $P
done
databricks fs ls dbfs:/Volumes/frostsight/landing/raw/frost_history/2026/01/01/ --profile $P
databricks fs ls dbfs:/Volumes/frostsight/landing/raw/road_weather/ --profile $P
databricks fs ls dbfs:/Volumes/frostsight/landing/raw/elevation/ --profile $P

# row counts over the volume (JSON lines is read by format => 'json')
databricks experimental aitools tools query "SELECT count(*) AS stations FROM read_files('/Volumes/frostsight/landing/raw/nvdb_stations/', format => 'json')" --profile $P
databricks experimental aitools tools query "SELECT count(*) AS links, round(sum(lengde)/1000) AS km FROM read_files('/Volumes/frostsight/landing/raw/nvdb_road_network/', format => 'json')" --profile $P
databricks experimental aitools tools query "SELECT count(*) AS accidents, min(_collected_at) FROM read_files('/Volumes/frostsight/landing/raw/nvdb_accidents/', format => 'json')" --profile $P
databricks experimental aitools tools query "SELECT count(*) AS slides FROM read_files('/Volumes/frostsight/landing/raw/nvdb_avalanche/', format => 'json')" --profile $P
databricks experimental aitools tools query "SELECT count(DISTINCT _metadata.file_path) AS files, count(*) AS rows, count(DISTINCT station_id) AS stations FROM read_files('/Volumes/frostsight/landing/raw/frost_history/', format => 'json')" --profile $P
databricks experimental aitools tools query "SELECT station_ref, measurement_time, air_temperature, road_surface_temperature FROM read_files('/Volumes/frostsight/landing/raw/road_weather/', format => 'json') LIMIT 5" --profile $P

# expected: stations = 30, links in the tens of thousands, accidents about 480, slides 5470,
# frost files = stations x 5 months (minus stations with no PT10M data), road_weather rows carry a station_ref

# local
cd project && uv run ruff check collector && uv run pytest -q tests/unit
cat config/replay_events.yml
```

If `experimental aitools tools query` is missing in your CLI version, run the same SQL in the SQL
editor of the team workspace on the serverless warehouse; the result is the same.
