# M0: Accounts, tooling and sources verified

Owners: Shawon (sources, credentials), Rayhan (team workspace, CLI, pilot county), Safiul (ADRs, gate).
Read `00_README.md` first. Conventions, names and the two targets come from there.

Goal: every engineer can log in to both workspaces and run the CLI; every MVP source returns real
data from a script on a laptop; the pilot county is fixed; four ADRs are written. M0 ends with a hard
gate (section "M0 gate").

What "source verified" means here: a script in the repo, not a browser, gets HTTP 200 and real rows.
The 28 Sep 2026 verification (`../source-verification.md`) did this by hand with curl;
M0 repeats it from code and adds the two sources that need credentials.

| Task | Owner | Depends on |
|---|---|---|
| T0.1 Team and personal Free Edition accounts | Safiul, all | nothing |
| T0.2 Databricks CLI and OAuth profiles | Rayhan, all | T0.1 |
| T0.3 Local Python toolchain | Rayhan | nothing |
| T0.4 Data access registrations and secret storage | Shawon | T0.2 |
| T0.5 Source verification script | Shawon | T0.3, T0.4 |
| T0.6 Pilot county decision | Rayhan | T0.5 |
| T0.7 ADRs 0001 to 0004 | Safiul | T0.4, T0.6 |
| T0.8 Capture fixtures | Shawon | T0.5 |
| T0.9 M0 gate | Safiul | all |

### T0.1 Team and personal Free Edition accounts      owner: Safiul (team), everyone (personal)
Why: Free Edition quotas are per account, so the team gets one shared workspace for the integrated
system and each engineer gets a personal one for iteration (`../platform-targets.md`, section 2).
Do:
  1. Safiul signs up at `https://login.databricks.com/?intent=CE_SIGN_UP`. Sign-in options on Free
     Edition are email one-time code, Google, or Microsoft; no SSO or SCIM (Free Edition limitations
     page, 25 Sep 2026). Use the Cefalo Microsoft account if the tenant allows it; otherwise a personal
     Google account. Record which one you used in the team channel, because the CLI login uses the same.
  2. After signup the browser lands on the workspace. Copy the URL from the address bar. It looks like
     `https://dbc-xxxxxxxx-xxxx.cloud.databricks.com`. Paste it into the team channel now; M2 puts it
     into the CLI profile and the GitHub secret `DATABRICKS_HOST`, never into a file in the repo. verify: the URL in your own browser; the pattern is not documented.
  3. Add the four others as users, then make them admins. UI path (verify: menu names change):
     top-right avatar > Settings > Identity and access > Users > Add user > enter email > Add.
     Then on each user row open the Admin toggle (or Groups > admins > Add members). Users cannot be
     removed afterwards on Free Edition, so type emails carefully.
  4. Each of Shawon, Sani, Rayhan, Sohanur: accept the invitation email, sign in with the same
     provider the invitation was sent to, confirm you see the team workspace URL.
  5. Each engineer, including Safiul, also creates a personal Free Edition account with the same
     signup link. Use the same sign-in provider you used for the team account; it keeps the browser
     OAuth flow in T0.2 simple. Note the personal workspace URL.
  6. In the team workspace, Safiul opens SQL Editor, picks the default serverless SQL warehouse
     (Free Edition gives one 2X-Small) and runs `SELECT current_user(), current_metastore();`.
     Everyone else runs the same query in their personal workspace.
Expect: two workspace URLs per engineer; the SQL query returns your email and a metastore id; in
the team workspace Settings > Users lists five users with Admin on.
If it fails:
  - Invitation email not received: check spam; re-send from Users; the email must match the provider
    (a Google invitation sent to an Outlook address will not log in with Microsoft).
  - "Sign in with Microsoft" refused by the tenant: use a personal Google account for both workspaces.
  - No SQL warehouse visible: wait a few minutes after signup; Free Edition provisions it lazily.

### T0.2 Databricks CLI and OAuth profiles      owner: Rayhan (write-up), everyone (run it)
Why: everything after M0 is driven from the CLI (bundles, volume uploads, secrets, SQL checks). Two
profiles map to the two Free Edition workspaces; a third name is reserved for the AWS target at M4.
Do:
  1. Run the floor check (from the `databricks-core` skill; it prints `OK`, `UPGRADE` or `INSTALL`):
     ```bash
     (
       have=""
       for probe in "--version" "version"; do
         raw="$(databricks "$probe" 2>/dev/null)"
         have="$(printf '%s' "$raw" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1)"
         [ -n "$have" ] && break
       done
       if [ -z "$have" ]; then echo "INSTALL"; exit 2; fi
       verdict="$(awk -v a="$have" 'BEGIN{split(a,A,".");split("1.0.0",B,".");for(i=1;i<=3;i++){x=A[i]+0;y=B[i]+0;if(x<y){print "UPGRADE";exit}if(x>y){print "OK";exit}}print "OK"}')"
       echo "$verdict: databricks CLI $have (floor v1.0.0)"
     )
     ```
  2. If `INSTALL` or `UPGRADE`, install the modern binary (not the PyPI `databricks-cli` package):
     ```bash
     # macOS and Linux with Homebrew
     brew tap databricks/tap && brew install databricks     # upgrade: brew upgrade databricks
     # macOS and Linux without Homebrew
     curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh
     # Linux without sudo: manual install to ~/.local/bin, see the skill's databricks-cli-install.md
     # Windows (Command Prompt, then restart the terminal)
     winget install Databricks.DatabricksCLI                # upgrade: winget upgrade Databricks.DatabricksCLI
     ```
     Verify with `databricks -v`. It must print 1.0.0 or higher.
  3. Create one OAuth profile per workspace. `--profile` is required or the login is not saved.
     A browser window opens; sign in with the same provider as in T0.1.
     ```bash
     databricks auth login --host https://<team-workspace>.cloud.databricks.com --profile frostsight-free
     databricks auth login --host https://<personal-workspace>.cloud.databricks.com --profile frostsight-personal
     ```
     Do not create a `DEFAULT` profile. Do not create `frostsight-aws` yet; that name is reserved
     for the AWS trial workspace created at M4 (`00_README.md` section 2). Never use a personal
     access token for interactive work; OAuth is the rule.
  4. Check both profiles:
     ```bash
     databricks auth profiles
     databricks current-user me --profile frostsight-free
     databricks current-user me --profile frostsight-personal
     ```
  5. Read the caveat and keep it in mind for the whole project: when a command runs from Claude
     Code, a CI step, or any tool that opens a fresh shell per command, `export
     DATABRICKS_CONFIG_PROFILE=...` on one line does nothing for the next line. Put `--profile
     frostsight-free` on every command, or chain `export ... && databricks ...` on one line. Every
     command in these milestone files carries `--profile` for that reason.
Expect: `databricks auth profiles` lists `frostsight-free` and `frostsight-personal` with `Valid: YES`;
`current-user me` prints a JSON with your `userName` (email) for each profile.
If it fails:
  - `cannot configure default credentials`: you forgot `--profile`.
  - Browser opens but the CLI hangs on "OAuth callback server listening": port 8020 is taken
    (`lsof -i :8020`), close it and retry.
  - `Valid: NO` after a week: tokens expire; re-run the same `auth login` line.

### T0.3 Local Python toolchain      owner: Rayhan
Why: the collector, the verification script and the unit tests run on laptops and in GitHub Actions;
everyone needs the same interpreter and lock file. The single `pyproject.toml` at the repo root
is already in the scaffold; this task installs the toolchain and creates the lock file.
Do:
  1. Install uv if missing: `curl -LsSf https://astral.sh/uv/install.sh | sh` (Windows:
     `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`). Then `uv python install 3.12`.
  2. Create `pyproject.toml`. This is the one and only project project file: it builds
     the `frostsight` wheel that jobs install (M2 `artifacts` block), and it installs the collector
     alone on a host without Spark. `03_M2` and `05_M4` reference this file; do not create a second
     version. Content:
     ```toml
     [project]
     name = "frostsight"
     version = "0.1.0"
     description = "FrostSight project: collector, pipelines, risk engine"
     requires-python = ">=3.12,<3.13"
     # Runtime dependencies of the wheel inside a serverless job. Spark, delta and databricks-sdk
     # are preinstalled there; everything else is dev-only or an extra.
     dependencies = ["pyyaml>=6", "requests>=2.32"]

     [project.optional-dependencies]
     collector = ["databricks-sdk>=0.50", "pyproj>=3.7"]      # laptop, GitHub Actions, static-IP host
     geo = ["pyproj>=3.7", "shapely>=2.0", "h3>=4.1"]         # reference job (05_M4 lists them in the job environment too)

     [dependency-groups]
     dev = [
         "pytest>=8",
         "ruff>=0.11",
         "pyspark>=3.5,<4",          # local unit tests of src/frostsight only
         "delta-spark>=3.2,<4",      # DeltaTable in load_reference / build_gold unit tests
         "pandas>=2.2",              # replay day selection (M1), fixtures, pandas UDFs
         "databricks-sdk>=0.50",
         "pyproj>=3.7",
         "shapely>=2.0",
         "h3>=4.1",
     ]

     [build-system]
     requires = ["hatchling"]
     build-backend = "hatchling.build"

     [tool.hatch.build.targets.wheel]
     # src/frostsight is imported as `frostsight`; collector/ is imported as `collector`.
     packages = ["src/frostsight", "collector"]

     [tool.ruff]
     line-length = 110
     target-version = "py312"

     [tool.ruff.lint]
     select = ["E", "F", "I", "B", "UP"]

     [tool.pytest.ini_options]
     testpaths = ["tests/unit"]
     pythonpath = ["src", "."]
     ```
     `databricks-connect` is not in this file on purpose: Connect ships its own `pyspark` and the
     two cannot share an environment. Unit tests use plain `pyspark`. If you want to run code
     against serverless from the IDE, create a separate venv by hand (`uv venv .venv-connect &&
     uv pip install --python .venv-connect databricks-connect`).
  3. From the repo root: `uv sync` (installs the `dev` group by default and the project itself in
     editable mode), then `uv run python -c "import requests, h3, pyproj, shapely, pyspark, frostsight;
     print('ok')"`. The `frostsight` import works once `src/frostsight/__init__.py` exists (M2
     creates it; until then drop it from the check). Commit `uv.lock`; CI (M2) runs
     `uv sync --frozen` against it.
  4. Confirm the wheel builds: `uv build --wheel` writes `dist/frostsight-0.1.0-py3-none-any.whl`
     (`dist/` is already ignored by the root `.gitignore`). Delete `dist/` afterwards if you like;
     the bundle rebuilds it on every deploy.
Expect: `uv run pytest -q` in the repo root collects zero tests and exits 5 (no tests yet), no import errors.
If it fails:
  - `pyproj` wheel build fails on Linux: `uv sync` picks a wheel for 3.12 on manylinux; if it tries
    to build, your Python is not 3.12. Check `uv run python --version`.
  - Java missing for `pyspark`: install a JDK 17 (`brew install openjdk@17` or `apt install openjdk-17-jre`).
  - `hatchling` cannot find `src/frostsight`: the folder does not exist yet (M2). Create it with an
    empty `__init__.py` now if you want `uv build` to pass at M0.

### T0.4 Data access registrations and secret storage      owner: Shawon
Why: two MVP-critical feeds need credentials: DATEX II (road weather every 10 min, incidents) and
MET Frost (last winter's history). Both are free. The verification file records the 401 responses
without them (`../source-verification.md`, "Endpoints tested").
Do:
  1. DATEX II. Fill the access form linked from
     `https://www.vegvesen.no/en/fag/technology/open-data/a-selection-of-open-data/what-is-datex/get-access/`.
     Fields (from the verification file): company or organisation name (Cefalo), organisation number,
     your name, email, "fixed IP address or DNS name to access the service", purpose. For purpose write:
     "Non-commercial open-data project: near-real-time road-weather and incident feed for Troms county,
     ingested into a Databricks lakehouse for icing-risk analysis. NPRA will be credited as source."
     For the IP field, if the team already has a Cefalo server with a static IP, put that IP. If not,
     put "to be confirmed, see email" and send the email in step 2 the same day.
  2. Email Statens vegvesen (the address given on the get-access page) with this exact question,
     because the answer decides the collector host at M2:
     "We are requesting DATEX II access for a non-commercial open-data project. Our poller will run from
     GitHub Actions, which has no fixed egress IP. Is the fixed IP or DNS name on the form enforced by
     an allow-list, or is it for information only? If it is enforced, can we register a DNS name
     that we control instead of an IP?"
     Record the answer in ADR 0004 (T0.7).
  3. MET Frost. Register at `https://frost.met.no/auth/requestCredentials.html` with your email.
     You receive a client id and a client secret. Only the client id is needed; it is the basic-auth
     username with an empty password (`curl --user <client id>:`, Frost how-to page).
  4. Also read the MET terms: attribution "Data from MET Norway, CC BY 4.0" goes into
     `bronze.source_metadata` later; Locationforecast needs a User-Agent that identifies us.
  5. Store the credentials in three places, never in code and never in a notebook:
     - Locally: `.env` (already covered by the root `.gitignore` pattern `.env`). Keys:
       ```
       DATEX_USER=
       DATEX_PASSWORD=
       FROST_CLIENT_ID=
       NVDB_CLIENT=frostsight
       MET_USER_AGENT=frostsight-collector/0.1 github.com/safiulanik-cefalo/FrostSight
       ```
       Commit a `.env.example` with the same keys and empty values.
     - GitHub: repo Settings > Secrets and variables > Actions > New repository secret, same names.
       The collector workflow (M2) reads them as `${{ secrets.DATEX_USER }}`.
     - Databricks: a Databricks-backed secret scope, needed only where the collector runs inside a
       job (the `aws` target) but cheap to create now on the team workspace:
       ```bash
       databricks secrets create-scope frostsight --profile frostsight-free
       databricks secrets put-secret frostsight datex_user       --string-value '<user>'     --profile frostsight-free
       databricks secrets put-secret frostsight datex_password   --string-value '<password>' --profile frostsight-free
       databricks secrets put-secret frostsight frost_client_id  --string-value '<id>'       --profile frostsight-free
       databricks secrets list-secrets frostsight --profile frostsight-free
       ```
       `create-scope` takes the scope name as a positional argument; `put-secret` takes `SCOPE KEY`
       positionally and the value through `--string-value` (verify: `databricks secrets put-secret --help`;
       if the flag is absent in your CLI version, omit it and the command reads the value from stdin).
       verify: Free Edition accepts `create-scope`; the limitations page does not mention secret scopes
       either way. If it errors with a permission or feature message, note it in ADR 0003 and rely on
       GitHub secrets until the AWS workspace exists. Inside a notebook the value is read with
       `dbutils.secrets.get(scope="frostsight", key="datex_user")`; inside a Python-file job task use
       `WorkspaceClient().dbutils.secrets.get(scope="frostsight", key="datex_user")` (the SDK's dbutils).
  6. Put the DATEX and Frost credentials in the team password manager entry "FrostSight sources".
     Every engineer copies them into their own `.env`.
Expect: DATEX form submitted, email sent (paste both into the M0 gate notes with dates); a Frost
client id in `.env`; `databricks secrets list-secrets frostsight --profile frostsight-free` lists
three keys; `git status` never shows `.env`.
If it fails:
  - DATEX form asks for an organisation number you do not have: use Cefalo's; ask Safiul.
  - No answer from Statens vegvesen within five working days: proceed with the static-IP host plan
    (ADR 0004) and keep the question open.
  - `put-secret` rejects the value: it must be a single line; multi-line secrets go through stdin
    (`printf '%s' "$VALUE" | databricks secrets put-secret frostsight key --profile frostsight-free`).

### T0.5 Source verification script      owner: Shawon
Why: the go/no-go rule from the plan: every MVP source must return real data from a script before M2.
The script also becomes the first collector test at M1.
Do:
  1. Create `tools/verify_sources.py` (folder `tools/`, not `scripts/`: the root
     `.gitignore` has a bare `scripts/` pattern that would ignore the file in any subfolder):
     ```python
     """Hit every FrostSight source once and print a status table.

     Credentials come from environment variables (load .env first, for example with
     `uv run --env-file .env python tools/verify_sources.py`). Sources whose credentials are
     missing are reported as SKIPPED, not failed.
     """

     from __future__ import annotations

     import os
     import sys
     import time
     from dataclasses import dataclass

     import requests

     NVDB = "https://nvdbapiles.atlas.vegvesen.no"
     TRAFIKKDATA = "https://trafikkdata-api.atlas.vegvesen.no/"
     MET_FORECAST = "https://api.met.no/weatherapi/locationforecast/2.0/compact"
     OPEN_METEO = "https://api.open-meteo.com/v1/elevation"
     FROST = "https://frost.met.no"
     DATEX = "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi"
     COUNTY = int(os.environ.get("FROSTSIGHT_COUNTY", "55"))
     TIMEOUT = 60
     USER_AGENT = os.environ.get("MET_USER_AGENT", "frostsight-verify/0.1 (+https://github.com/safiulanik-cefalo/FrostSight)")


     @dataclass
     class Check:
         name: str
         status: str  # OK | FAIL | SKIPPED
         detail: str
         ms: int = 0


     def _get(url: str, **kw) -> requests.Response:
         kw.setdefault("timeout", TIMEOUT)
         kw.setdefault("headers", {})
         kw["headers"].setdefault("User-Agent", USER_AGENT)
         return requests.get(url, **kw)


     def check_nvdb() -> list[Check]:
         headers = {"X-Client": os.environ.get("NVDB_CLIENT", "frostsight"), "Accept": "application/json"}
         out: list[Check] = []
         for name, type_id in {"nvdb_stations_153": 153, "nvdb_accidents_570": 570, "nvdb_slides_445": 445}.items():
             r = _get(f"{NVDB}/vegobjekter/{type_id}/statistikk", params={"fylke": COUNTY}, headers=headers)
             ok = r.status_code == 200 and r.json().get("antall", 0) > 0
             out.append(Check(name, "OK" if ok else "FAIL", f"{r.status_code} antall={r.json().get('antall') if ok else r.text[:80]}"))
         r = _get(f"{NVDB}/vegnett/veglenkesekvenser/segmentert", params={"fylke": COUNTY, "antall": 1}, headers=headers)
         ok = r.status_code == 200 and r.json()["metadata"]["returnert"] == 1
         out.append(Check("nvdb_road_links", "OK" if ok else "FAIL", f"{r.status_code} srid={r.json()['objekter'][0]['geometri']['srid'] if ok else '-'}"))
         return out


     def check_trafikkdata() -> Check:
         q = {"query": f"{{ trafficRegistrationPoints(searchQuery: {{countyNumbers: [{COUNTY}]}}) {{ id name }} }}"}
         r = requests.post(TRAFIKKDATA, json=q, timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})
         n = len(r.json().get("data", {}).get("trafficRegistrationPoints", [])) if r.ok else 0
         return Check("trafikkdata_graphql", "OK" if n else "FAIL", f"{r.status_code} points={n}")


     def check_met_forecast() -> Check:
         r = _get(MET_FORECAST, params={"lat": 69.65, "lon": 18.96})
         n = len(r.json()["properties"]["timeseries"]) if r.ok else 0
         return Check("met_locationforecast", "OK" if n else "FAIL", f"{r.status_code} timesteps={n}")


     def check_open_meteo() -> Check:
         r = _get(OPEN_METEO, params={"latitude": "69.65,69.22", "longitude": "18.96,19.60"})
         return Check("open_meteo_elevation", "OK" if r.ok else "FAIL", f"{r.status_code} {r.json().get('elevation') if r.ok else r.text[:80]}")


     def check_frost() -> Check:
         cid = os.environ.get("FROST_CLIENT_ID")
         if not cid:
             return Check("met_frost_sources", "SKIPPED", "FROST_CLIENT_ID not set")
         r = _get(f"{FROST}/sources/v0.jsonld", params={"stationholder": "STATENS VEGVESEN"}, auth=(cid, ""))
         n = len(r.json().get("data", [])) if r.ok else 0
         return Check("met_frost_sources", "OK" if n else "FAIL", f"{r.status_code} svv_stations_norway={n}")


     def check_datex() -> list[Check]:
         user, pw = os.environ.get("DATEX_USER"), os.environ.get("DATEX_PASSWORD")
         if not (user and pw):
             return [Check("datex_road_weather", "SKIPPED", "DATEX_USER/DATEX_PASSWORD not set"), Check("datex_situations", "SKIPPED", "same")]
         out = []
         for name, path in {"datex_road_weather": "GetMeasuredWeatherData", "datex_situations": "GetSituation"}.items():
             r = _get(f"{DATEX}/{path}/pullsnapshotdata", auth=(user, pw))
             ok = r.ok and r.content.lstrip().startswith(b"<")
             out.append(Check(name, "OK" if ok else "FAIL", f"{r.status_code} bytes={len(r.content)}"))
         return out


     def timed(fn) -> list[Check]:
         t0 = time.perf_counter()
         try:
             result = fn()
         except Exception as exc:  # noqa: BLE001 - one bad source must not hide the others
             result = Check(fn.__name__.removeprefix("check_"), "FAIL", f"{type(exc).__name__}: {exc}"[:100])
         checks = result if isinstance(result, list) else [result]
         ms = int((time.perf_counter() - t0) * 1000)
         for c in checks:
             c.ms = ms
         return checks


     def main() -> int:
         checks = [c for fn in (check_nvdb, check_trafikkdata, check_met_forecast, check_open_meteo, check_frost, check_datex) for c in timed(fn)]
         width = max(len(c.name) for c in checks)
         print(f"{'source':<{width}}  status   ms     detail")
         for c in checks:
             print(f"{c.name:<{width}}  {c.status:<7}  {c.ms:<5}  {c.detail}")
         return 1 if any(c.status == "FAIL" for c in checks) else 0


     if __name__ == "__main__":
         sys.exit(main())
     ```
  2. Run it: `cd project && uv run --env-file .env python tools/verify_sources.py`.
  3. Paste the output into the M0 gate notes. Re-run after the DATEX account arrives.
Expect (numbers from the 28 Sep 2026 verification; yours will drift slightly):
  ```
  source                 status   ms     detail
  nvdb_stations_153      OK       800    200 antall=30
  nvdb_accidents_570     OK       800    200 antall=8248
  nvdb_slides_445        OK       800    200 antall=5470
  nvdb_road_links        OK       800    200 srid=5973
  trafikkdata_graphql    OK       600    200 points=147
  met_locationforecast   OK       400    200 timesteps=80
  open_meteo_elevation   OK       300    200 [9.0, 34.0]
  met_frost_sources      OK       500    200 svv_stations_norway=350
  datex_road_weather     OK       2000   200 bytes=1500000
  datex_situations       OK       2000   200 bytes=600000
  ```
  Exit code 0. Before credentials exist the last three lines say `SKIPPED` and the exit code is still 0.
If it fails:
  - NVDB 400 "X-Client må være satt": the header is missing; check `NVDB_CLIENT` and the `headers=`
    argument. NVDB v3 hosts reject generic User-Agents; only v4 is used here.
  - MET 403: the User-Agent is generic; MET requires one that identifies the application.
  - Frost 401 with a client id: the id is the basic-auth username, the password is empty; check for
    trailing whitespace in `.env`.
  - DATEX 401 with credentials: the account may be IP-restricted; that is the T0.4 question.

### T0.6 Pilot county decision      owner: Rayhan
Why: one county keeps the NVDB extract, the station lookup and the SQL warehouse load small. The
decision needs numbers, not opinions.
Do:
  1. Run the NVDB statistics for both candidates. Type 153 is road-weather stations, 570 accidents,
     445 avalanche and landslide. The date filter uses property 5055 (Ulykkesdato) for 570.
     ```bash
     for f in 55 34; do
       for t in 153 570 445; do
         printf "fylke=%s type=%s " "$f" "$t"
         curl -s -H "X-Client: frostsight" "https://nvdbapiles.atlas.vegvesen.no/vegobjekter/$t/statistikk?fylke=$f"; echo
       done
       printf "fylke=%s type=570 since 2021 " "$f"
       curl -s -G -H "X-Client: frostsight" "https://nvdbapiles.atlas.vegvesen.no/vegobjekter/570/statistikk" \
         --data-urlencode "fylke=$f" --data-urlencode "egenskap=5055>=2021-01-01"; echo
     done
     ```
  2. Fill the table in ADR 0002. Values observed on 28 Sep 2026:

     | Metric | Troms (55) | Innlandet (34) | Source |
     |---|---|---|---|
     | Road-weather stations (153) | 30 | 61 | statistikk |
     | Accidents (570), all years | 8,248 | 25,566 | statistikk |
     | Accidents (570), 2021 onwards | 483 | 1,723 | statistikk with `egenskap=5055>=2021-01-01` |
     | Avalanche and landslide (445) | 5,470 | 671 | statistikk |
     | Traffic stations (482) | 147 | not checked | verification file |
     | Coast, fjords, mountain passes | yes | inland, less wind exposure | domain |
  3. Recommendation: Troms. It has 8 times more slide events, coastal wind and freeze-thaw cycles
     (the icing signal the MVP scores), and a small station count that makes the station-to-segment
     lookup and the map trivially fast on a 2X-Small warehouse. Innlandet has twice the stations and
     accidents, which matters only for the ML stretch. If Sohanur needs more labels at S3, the
     collector takes `--county 34` and the extract is rerun; nothing else changes.
  4. Write the decision into ADR 0002. The number lands in two places later: bundle variable
     `pilot_county` (default `"55"`, `03_M2` T2.2) and `config/sources.yml` (M2). Until then the ADR
     is the record.
Expect: the ADR shows the table and the decision; the README already states Troms, fylke 55.
If it fails:
  - `statistikk` returns `antall: 0` for a type: the type id is wrong or the county number changed
    (counties were renumbered in 2024; `omrader/fylker` lists the current ones).

### T0.7 ADRs 0001 to 0004      owner: Safiul
Why: the four decisions everything else assumes. Reviewers at M3 read these first.
Do:
  1. The scaffold already contains them, with Status Proposed, in `docs/adr/`:
     `0001-product-scope.md`, `0002-pilot-county.md`, `0003-deployment-targets.md`,
     `0004-external-collector.md`, and the template `0000-template.md`.
  2. Rayhan fills the ADR 0002 table from T0.6 if the figures changed.
  3. Each team member reviews the four ADRs in one pull request. Set Status to Accepted after two approvals.
Expect: four ADRs with Status Accepted on `main`.
If it fails:
  - Disagreement on the county: keep ADR 0002 Proposed, timebox to one meeting, default to Troms.

### T0.8 Capture fixtures      owner: Shawon
Why: unit tests at M1 and M4 must run without network. One small real response per source, under
200 KB each, committed to `tests/fixtures/`.
Do:
  1. Create the folder and capture (all from the repo root, with `.env` loaded for the last two):
     ```bash
     mkdir -p tests/fixtures
     H='X-Client: frostsight'
     B=https://nvdbapiles.atlas.vegvesen.no
     curl -s -H "$H" "$B/vegobjekter/153?fylke=55&antall=5&inkluder=lokasjon,geometri,egenskaper"   > tests/fixtures/nvdb_153_stations.json
     curl -s -H "$H" "$B/vegobjekter/105?fylke=55&antall=5&inkluder=lokasjon,geometri,egenskaper"   > tests/fixtures/nvdb_105_speed_limits.json
     curl -s -G -H "$H" "$B/vegobjekter/570" --data-urlencode fylke=55 --data-urlencode antall=5 \
       --data-urlencode inkluder=lokasjon,geometri,egenskaper --data-urlencode "egenskap=5055>=2024-01-01" > tests/fixtures/nvdb_570_accidents.json
     curl -s -G -H "$H" "$B/vegobjekter/445" --data-urlencode fylke=55 --data-urlencode antall=5 \
       --data-urlencode inkluder=lokasjon,geometri,egenskaper --data-urlencode "egenskap=2324>=2025-11-01" > tests/fixtures/nvdb_445_slides.json
     curl -s -H "$H" "$B/vegnett/veglenkesekvenser/segmentert?fylke=55&antall=20"                      > tests/fixtures/nvdb_road_links.json
     curl -s -H "$H" "$B/omrader/fylker"                                                                > tests/fixtures/nvdb_fylker.json
     curl -s -H "User-Agent: frostsight-verify/0.1" "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=69.65&lon=18.96" > tests/fixtures/met_locationforecast.json
     curl -s "https://api.open-meteo.com/v1/elevation?latitude=69.65,69.22&longitude=18.96,19.60"       > tests/fixtures/open_meteo_elevation.json
     # with credentials
     set -a; . ./.env; set +a
     curl -s --user "$FROST_CLIENT_ID:" "https://frost.met.no/sources/v0.jsonld?stationholder=STATENS%20VEGVESEN" > tests/fixtures/frost_sources.json
     curl -s --user "$FROST_CLIENT_ID:" "https://frost.met.no/observations/v0.jsonld?sources=<one SN id from frost_sources.json>&elements=air_temperature&referencetime=2026-01-15T00:00:00Z/2026-01-15T06:00:00Z&timeresolutions=PT10M" > tests/fixtures/frost_observations.json
     curl -s --user "$DATEX_USER:$DATEX_PASSWORD" "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetMeasuredWeatherData/pullsnapshotdata" > /tmp/datex_weather_full.xml
     curl -s --user "$DATEX_USER:$DATEX_PASSWORD" "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetSituation/pullsnapshotdata" > /tmp/datex_situations_full.xml
     ls -la tests/fixtures
     ```
  2. The two DATEX snapshots are national and larger than 200 KB. Trim them by hand or with a tiny
     script to the first three `siteMeasurements` (weather) and first three `situation` elements,
     keeping the XML header and namespaces intact, and save as
     `tests/fixtures/datex_measured_weather.xml` and `tests/fixtures/datex_situations.xml`.
     verify: the element names above once the real file is in hand; DATEX II v3 profiles vary.
  3. Add a `tests/fixtures/README.md` with one line per file: source URL, capture date, licence
     (NLOD for Statens vegvesen, CC BY 4.0 for MET, CC BY 4.0 for Open-Meteo).
  4. Confirm every file is under 200 KB: `find tests/fixtures -size +200k`. It prints nothing.
Expect: 12 files, all parse (`python -c "import json,sys; json.load(open(sys.argv[1]))" f`), PR merged.
If it fails:
  - `nvdb_road_links.json` over 200 KB: 20 links is about 40 KB; if larger, lower `antall`.
  - Frost observations empty: the station has no `air_temperature` at PT10M; pick another SN id or
    drop `timeresolutions` for the fixture.

### T0.9 M0 gate      owner: Safiul
Why: the plan says any MVP source that cannot return real data from a script by M2 triggers the
fallback. M0 is where the evidence is collected.
Do: hold a 30-minute meeting; go through the checklist; record the outcome in the meeting notes with
the `verify_sources.py` output pasted in.

| Check | Evidence | Status |
|---|---|---|
| Team workspace exists, five admins | Settings > Users screenshot | |
| Five personal workspaces | each engineer posts `current-user me` output | |
| CLI >= 1.0.0 on every laptop, both profiles valid | `databricks auth profiles` output | |
| `pyproject.toml` and `uv.lock` merged, `uv sync` and `uv build --wheel` work on macOS, Linux, Windows | CI not yet; one screenshot per OS | |
| NVDB 153, 570, 445, 105, road links: OK | script output | |
| trafikkdata, MET forecast, Open-Meteo: OK | script output | |
| Frost: OK with client id | script output | |
| DATEX weather and situations: OK, or form submitted and IP question sent with dates | script output or email copy | |
| Secrets in `.env.example`, GitHub secrets, Databricks scope (or noted as unsupported) | `list-secrets` output | |
| Pilot county: Troms, ADR 0002 accepted | merged PR | |
| ADR 0001, 0003, 0004 accepted | merged PRs | |
| Fixtures under 200 KB with README | merged PR | |
| H3 and ST_ functions work on the Free Edition serverless warehouse | `SELECT h3_longlatash3(18.96, 69.65, 9)` returns a BIGINT and `SELECT ST_Distance(ST_Point(0, 0, 25833), ST_Point(3, 4, 25833))` returns `5.0` (ST_ functions are Public Preview on DBR 17.1+; the M3 benchmark and the M4 lookup depend on them) | |

The gate passes when every row is green except DATEX, which may be "form submitted, waiting" for at
most two more weeks (until the M2 gate). If DATEX is refused, the fallback is the MET Frost
near-real-time observations for the same stations (Frost updates hourly, not every 10 minutes); that
becomes ADR 0005.

## Done when

- Everyone has `frostsight-free` and `frostsight-personal` profiles valid on their laptop.
- `verify_sources.py` exits 0 with every non-credential source OK and Frost OK.
- DATEX credentials exist, or the form and the fixed-IP email are sent and dated.
- Pilot county is Troms (fylke 55), ADR 0002 merged; ADR 0001, 0003, 0004 merged.
- Fixtures are in `tests/fixtures/` with a README.
- Secrets exist in `.env` locally, in GitHub, and in the `frostsight` scope on the team workspace
  (or the scope limitation is recorded in ADR 0003).

## Verify

```bash
# CLI and profiles
databricks -v
databricks auth profiles
databricks current-user me --profile frostsight-free
databricks current-user me --profile frostsight-personal

# secrets scope on the team workspace
databricks secrets list-scopes --profile frostsight-free
databricks secrets list-secrets frostsight --profile frostsight-free

# warehouse and spatial functions on Free Edition (note the warehouse name: it is the bundle variable warehouse_name at M2)
databricks warehouses list --profile frostsight-free
databricks experimental aitools tools query "SELECT h3_longlatash3(18.96, 69.65, 9) AS h3_cell" --profile frostsight-free
databricks experimental aitools tools query "SELECT ST_Distance(ST_Point(0, 0, 25833), ST_Point(3, 4, 25833)) AS d" --profile frostsight-free   # expect 5.0
# if `experimental aitools` is missing in your CLI, paste the two SELECTs into the SQL editor instead

# sources
cd project && uv run --env-file .env python tools/verify_sources.py; echo "exit=$?"

# fixtures
find tests/fixtures -type f -size +200k     # prints nothing
ls tests/fixtures | wc -l                   # 12 files plus README

# ADRs (repo root)
ls docs/adr                                          # 0000-template, 0001 to 0004
git log --oneline main -- docs/adr | head
```
