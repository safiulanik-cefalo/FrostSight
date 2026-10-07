# ADR-0008: DATEX data from the open WFS

- Status: Proposed
- Date: 2026-10-07
- Owner: Safiul Anik

## Context

Road weather and incidents are two of the three MVP sources. The plan reads them from the DATEX II pull API
(`datex-server-get-v3-1.atlas.vegvesen.no/datexapi`), which needs a free account with Basic Auth. The access
form asks for a fixed IP address or DNS name. GitHub Actions and Free Edition serverless have no fixed
egress IP, so ADR-0004 left the collector host open until Statens vegvesen answers whether the IP is enforced.

On 2026-10-07 we found that Statens vegvesen also publishes the same DATEX publications as an open OGC WFS,
`https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs`, listed on its
[OGC map services page](https://www.vegvesen.no/fag/teknologi/apne-data/et-utvalg-apne-data/ogc-karttjenester/kartlag/).
Tested without credentials:

- `GetCapabilities` returns `Fees: NONE` and `AccessConstraints: NONE`. Registration is optional.
- `datex_3_1:WeatherSimple_v2` returns 468 stations nationally as flat GeoJSON, 24 in Troms, all with
  `ROAD_SURFACE_TEMPERATURE`; 22 of the 24 measured within the last hour. A 06:30 reading was published
  at 06:34. `REFERENCE_ID` equals the NVDB `Målestasjonsnummer` for 23 of 24 Troms stations.
- `datex_3_1:SituationSimple_v2` returns 2,659 situations nationally (10 MB), 153 inside the Troms bounding box
  when filtered server-side with `bbox`.
- `WeatherSimple_v2` has no road-surface state and leaves `PRECIPITATION_TYPE` null on every station. The full
  `datex_3_1:WeatherData` layer carries `precipitationType`, `weatherRelatedRoadConditionType` and friction.

## Options considered

1. DATEX II pull API with an account. The original plan. Blocked on the fixed-IP question; may need a
   static-IP host.
2. Open WFS, simple layers (`WeatherSimple_v2`, `SituationSimple_v2`). No account, no fixed IP, flat fields
   that map onto contract v1 with little code. Chosen.
3. Open WFS, full layers (`WeatherData`, `Situation`). Same access, nested DATEX structure, more fields. Kept as
   the fallback if a missing field (precipitation type, surface state) turns out to matter.
4. MET Frost as the live source. Free, but its publication delay for road-weather stations is not verified;
   it stays the history source.

## Decision

The collector reads road weather and incidents from the open WFS simple layers, as GeoJSON, with no
credentials. Endpoints, layer names and the bbox rule live in `config/sources.yml`.

- Road weather: `WeatherSimple_v2`, national, every pull. Silver filters to the county through the station
  table, as before.
- Incidents: `SituationSimple_v2` with a `bbox` around the pilot county, taken from the NVDB county
  `kartutsnitt` so nothing county-specific is hard-coded.
- The collector maps both to the unchanged contract v1 JSON lines (`road_weather/`, `road_incidents/`), so
  bronze, silver and gold do not change.
- The raw response is kept as `<source>_raw/<ts>.geojson` instead of `<source>_xml/<ts>.xml`.
- `station_ref` is `REFERENCE_ID`. `datex_sites` is built from the same weather response.
- `precipitation_type` is derived from intensity and air temperature with the replay harness's `precip_type`;
  `road_surface_state` is null, as it already is for Frost replay rows.

The DATEX account is no longer required for the MVP. ADR-0004 keeps the external collector because Free
Edition still restricts outbound access; its host choice no longer depends on the fixed IP.

The step-by-step change list for the plan and the collector is `docs/changes/0008-datex-open-wfs.md`.

## Consequences

- M0 T0.4 drops the DATEX form and the fixed-IP email; `DATEX_USER`/`DATEX_PASSWORD` secrets go away.
- GitHub Actions is enough to host the collector; the static-IP host is no longer needed for DATEX.
- The parser shrinks from namespace-agnostic XML walking to reading flat GeoJSON properties.
- Live precipitation type is an approximation, the same one replay already uses. If the risk model needs the
  measured type or surface state, switch the weather pull to the full `WeatherData` layer (option 3).
- The WFS is a map service, not the documented DATEX distribution channel. It has no published SLA and
  layer names (`_v2`) may change; the M7 schema-change test and `_failed/` markers cover that.
- Licence: the service declares no fees or access constraints, and the underlying datasets are NLOD. Confirm
  with Statens vegvesen that NLOD covers the WFS distribution too; attribution stays "Statens vegvesen".
