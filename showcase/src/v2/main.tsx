// The /v2/ page: the same app, with land cover, houses and place names on each site (src/v2/variant.tsx).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../App";
import { ATTRIBUTION, AttributionContext } from "../app/Legend";
import { Perf } from "./Perf";
import { PLACES_ATTRIBUTION, PLACES_SITE } from "./variant";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/hud.css";
import "./places.css";

// ?perf shows frame rate, draw calls and triangles
const perf = new URLSearchParams(window.location.search).has("perf");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AttributionContext.Provider value={`${ATTRIBUTION} ${PLACES_ATTRIBUTION}`}>
      <App siteVariant={PLACES_SITE} />
      {perf && <Perf />}
    </AttributionContext.Provider>
  </StrictMode>,
);
