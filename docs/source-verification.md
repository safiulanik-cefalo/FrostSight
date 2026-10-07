# FrostSight: source verification

Date: 28 September 2026, DATEX WFS added 7 October 2026. Method: live HTTP requests with curl, with
failing hosts retried from a second location. No credentials were used. Companion to
`overview.md` and `architecture.md`.

## Summary

| Source | Status | One line |
|---|---|---|
| NVDB road network API | Works | `X-Client` header only, no key. Troms road links, speed limits, county list returned. |
| NVDB accidents (object type 570) | Works | 8,248 records in Troms with date, road and weather condition fields; 2024 records present. |
| NVDB avalanche and landslide (object type 445) | Works | 5,470 records in Troms with date, type and road damage fields. |
| NVDB road-weather station locations (object type 153) | Works | 30 stations in Troms with station number and 3D point geometry. |
| NVDB traffic registration stations (object type 482) | Works | 147 stations in Troms. |
| trafikkdata.no GraphQL | Works | No key. Troms registration points and hourly volumes returned. |
| MET Locationforecast | Works | User-Agent header only. Fresh Tromsø forecast returned. |
| MET Frost observations | Needs account | 401 without client ID. Free, email only. Statens vegvesen is a documented station holder. |
| DATEX road weather, open WFS `WeatherSimple_v2` | Works | No account (ADR-0008). 468 stations, 24 in Troms, all with road surface temperature; ids are NVDB station numbers. |
| DATEX incidents, open WFS `SituationSimple_v2` | Works | No account. 2,659 situations nationally, 153 in the Troms bbox. |
| DATEX road weather, full WFS `WeatherData` | Works | No account. Nested DATEX; adds precipitation type, road condition type, friction. Fallback layer. |
| DATEX II pull API: road weather, situations, site table | Needs account | 401. Free form, NLOD, asks for a fixed IP or DNS name. Superseded by the WFS for the MVP. |
| NVDB road closures (object type 485) | Works, history only | 996 Troms records; newest closure date October 2020, so not a live incident source. |
| Kartverket elevation (hoydedata), Kartverket kommuneinfo, Geonorge catalogue and download, WCS | Unreachable today | Timed out here and connection refused from a second location. Outage or geo-block, not our network. |
| Open-Meteo elevation API (fallback) | Works | No key. Returned 9 m and 34 m for two Troms points. |
| transportportal.no | Reachable | Catalogue only, no data endpoint. |

## Endpoints tested

| Endpoint | Headers or auth | Result |
|---|---|---|
| `https://nvdbapiles.atlas.vegvesen.no/vegobjekttyper?inkluder=minimum` | `X-Client: frostsight-probe` | 200, 544 KB, full object-type list |
| `https://nvdbapiles.atlas.vegvesen.no/vegobjekter/105?fylke=55&antall=1&inkluder=lokasjon,geometri,egenskaper` | same | 200, speed limit object with geometry |
| `https://nvdbapiles.atlas.vegvesen.no/vegobjekter/570/statistikk?fylke=55` | same | 200, `{"antall":8248}` |
| `https://nvdbapiles.atlas.vegvesen.no/vegobjekter/570?fylke=55&antall=3&inkluder=egenskaper&egenskap=5055>=2024-01-01` | same | 200, accidents dated May and June 2024 with `Føreforhold` and `Værforhold` |
| `https://nvdbapiles.atlas.vegvesen.no/vegobjekter/445/statistikk?fylke=55` | same | 200, `{"antall":5470}` |
| `https://nvdbapiles.atlas.vegvesen.no/vegobjekter/153/statistikk?fylke=55` | same | 200, `{"antall":30}`; sample objects carry `Målestasjonsnummer` and `POINT Z` geometry |
| `https://nvdbapiles.atlas.vegvesen.no/vegobjekter/482/statistikk?fylke=55` | same | 200, `{"antall":147}` |
| `https://nvdbapiles.atlas.vegvesen.no/vegnett/veglenkesekvenser?fylke=55&antall=1` | same | 200, link sequence with nodes |
| `https://nvdbapiles.atlas.vegvesen.no/omrader/fylker` | same | 200, county list with numbers |
| `https://nvdbapiles.atlas.vegvesen.no/...` without `X-Client` | none | 400, "X-Client må være satt når du kaller API Les V4" |
| `https://nvdbapiles-v3.atlas.vegvesen.no/...` (legacy v3) | User-Agent only | 400, wants a system-identifying User-Agent; use v4 instead |
| `https://trafikkdata-api.atlas.vegvesen.no/` GraphQL `trafficRegistrationPoints(countyNumbers:[55])` | none | 200, points with coordinates |
| same, `trafficData(trafficRegistrationPointId:"83641V1126289").volume.byHour(...)` | none | 200, hourly volumes for 26 Sep 2026 |
| `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=69.65&lon=18.96` | User-Agent | 200, 38 KB forecast |
| `https://frost.met.no/sources/v0.jsonld?stationholder=STATENS%20VEGVESEN&county=55` | none or dummy ID | 401 Unauthorized |
| `https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetSituation/pullsnapshotdata` | none | 401 |
| `https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetMeasuredWeatherData/pullsnapshotdata` | none | 401 |
| `https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetMeasurementWeatherSiteTable/pullsnapshotdata` | none | 401 |
| `https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs?service=wfs&request=GetCapabilities` | none | 200, 16 feature types; `Fees: NONE`, `AccessConstraints: NONE` |
| `.../datex_3_1/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=datex_3_1:WeatherSimple_v2&outputFormat=application/json` | none | 200, 440 KB, 468 features; newest `MEASUREMENT_TIME` 06:30, `PUBLICATION_TIME` 06:34 local |
| same, plus `CQL_FILTER=COUNTY='Troms'` | none | 200, 23 KB, 24 features; `REFERENCE_ID` matches NVDB `Målestasjonsnummer` for 23 |
| `...typeNames=datex_3_1:SituationSimple_v2&outputFormat=application/json` | none | 200, 10 MB, 2,659 features |
| same, plus `srsName=EPSG:4326&bbox=68.3,15.5,70.4,22.9,urn:ogc:def:crs:EPSG::4326` | none | 200, 0.8 MB, 153 features |
| `...typeNames=datex_3_1:WeatherData&...&bbox=` (Troms) | none | 200, 0.5 MB, 31 features, nested DATEX `physicalQuantity` |
| `https://nvdbapiles.atlas.vegvesen.no/omrader/fylker?inkluder=alle&srid=4326` | `X-Client` | 200; Troms `kartutsnitt` lat 68.21 to 70.78, lon 15.59 to 23.27 (lat first) |
| `https://nvdbapiles.atlas.vegvesen.no/vegobjekter/485?fylke=55` | `X-Client` | 200, 996 closures; newest `Stengt fra dato` 2020-10-02 |
| `https://ws.geonorge.no/hoydedata/v1/punkt?...` | none | timeout (60 s) here; ECONNREFUSED from second location |
| `https://api.kartverket.no/kommuneinfo/v1/fylker` | none | timeout here; ECONNREFUSED from second location |
| `https://kartkatalog.geonorge.no/`, `https://nedlasting.geonorge.no/api/capabilities/`, `https://wms.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833`, `https://www.kartverket.no/`, `https://hoydedata.no/` | none | timeout here; nedlasting refused from second location |
| `https://api.open-meteo.com/v1/elevation?latitude=69.65,69.22&longitude=18.96,19.60` | none | 200, `{"elevation":[9.0, 34.0]}` |
| `https://transportportal.no/` | none | 200, catalogue page |

## What the documentation says

- DATEX II (Statens vegvesen): free of charge, NLOD licence, Basic Auth username and password.
  Weather measurements update every 10 minutes, forecasts hourly, travel times every 5 minutes,
  plus situations (accidents, roadworks, weather events) and webcams. The access form requires
  company or organisation name, organisation number, name, email, "fixed IP address or DNS name
  to access the service", and purpose. Conditions: do not distort the information, keep
  credentials confidential, always credit NPRA as source.
  Sources: [What is DATEX](https://www.vegvesen.no/en/fag/technology/open-data/a-selection-of-open-data/what-is-datex/),
  [Request access](https://www.vegvesen.no/en/fag/technology/open-data/a-selection-of-open-data/what-is-datex/get-access/),
  [Road weather data dataset](https://dataut.vegvesen.no/en/dataset/vaerdata).
- DATEX open WFS (Statens vegvesen OGC services): `datex_3_1` serves the DATEX publications Situation,
  TravelTime, WeatherData, ForecastPoint and Cctv, each as a full layer, a `Simple` layer and a `Simple_v2`
  layer. Registration is optional (it only subscribes you to change notices). `WeatherSimple_v2` fields:
  `REFERENCE_ID`, `MEASUREMENT_TIME`, `PUBLICATION_TIME`, `COUNTY`, `ROAD_NUMBER`, `LOCATION_DESCRIPTION`,
  `AIR_TEMPERATURE`, `ROAD_SURFACE_TEMPERATURE`, `DEW_POINT_TEMPERATURE`, `RELATIVE_HUMIDITY`,
  `PRECIPITATION_INTENSITY`, `PRECIPITATION_TYPE` (null everywhere on 7 Oct), `WIND_SPEED`,
  `WIND_DIRECTION_BEARING`, `DEPTH_OF_SNOW`, visibility and min/max temperature. `SituationSimple_v2`
  fields include `RECORD_ID`, `VERSION`, `SITUATION_ID`, `SITUATION_TYPE`, `SECONDARY_TYPES`, `SEVERITY`,
  `START_TIME`, `END_TIME`, `ACTIVE`, `ROAD_NUMBER`, `DESCRIPTION` and a display point. A record with several
  validity periods appears once per period with the same `RECORD_ID` and `VERSION`.
  Sources: [OGC map services](https://www.vegvesen.no/fag/teknologi/apne-data/et-utvalg-apne-data/ogc-karttjenester/kartlag/),
  [Road traffic information dataset](https://dataut.vegvesen.no/en/dataset/trafikkmeldinger).
- MET Frost: free, register with an email to get a client ID and secret. Frost documents
  querying stations by `stationholder=STATENS VEGVESEN`. Resolution and coverage of road-weather
  stations not verified without a client ID.
  Sources: [Frost how-to](https://frost.met.no/howto.html), [Frost station examples](https://frost.met.no/ex_userquest).
- NVDB API v4: requires an `X-Client` header identifying the system. The legacy v3 host rejects
  generic User-Agents; use v4.

## Findings that change the plan

1. **DATEX fixed IP: resolved by the open WFS (ADR-0008).** The pull API's access form asks for a
   fixed IP address or DNS name, which GitHub Actions and Free Edition serverless do not have. The
   same publications are on the open WFS with no account, so the MVP does not need the form. The
   plan changes are listed in `docs/changes/0008-datex-open-wfs.md`.
2. **Frost is the history source.** Replay and the demo depend on last winter's road-weather
   observations. Register a Frost client ID now and run one query against a Troms station to
   confirm resolution (expected PT10M) and coverage.
3. **Kartverket is out for now.** Elevation has two working fallbacks: the Open-Meteo elevation
   API and the Z coordinate in NVDB geometries. County and municipality boundaries come from
   NVDB `omrader`. Terrain is not a blocker.
4. **NVDB carries more than the road network.** Accidents, avalanche and landslide events,
   road-weather station locations and traffic registration stations are all NVDB object types,
   so four of the eight source families need only the one NVDB client.

## Net effect on the MVP

The three MVP sources are road weather, incidents and NVDB. All three are confirmed with no account:
road weather and incidents through the open DATEX WFS, NVDB with the `X-Client` header. Live
precipitation type is approximated and road surface state is absent in the simple weather layer
(ADR-0008).
Traffic, accidents, avalanche, forecasts and elevation fallbacks are confirmed with no
registration.

## Next actions

| Action | Owner | Milestone |
|---|---|---|
| ~~Submit the DATEX access form~~ replaced by the open WFS (ADR-0008); confirm the WFS is NLOD | E1 | M0 |
| Apply `docs/changes/0008-datex-open-wfs.md` to the plan and the collector | E1 | M0 to M2 |
| Register a Frost client ID; query one Troms station for last winter | E1 | M0 |
| Pull the NVDB Troms extract (links, type 153, 570, 445, 482) into a volume | E3 | M1 |
| Re-test Kartverket; if still unreachable, adopt Open-Meteo plus NVDB Z as the terrain source | E3 | M1 |
| Decide the collector host (GitHub Actions is now enough for DATEX) | E1, E3 | M2 |
