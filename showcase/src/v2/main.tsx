// SPIKE (throwaway): /v2 entry, the v1 page with land cover, houses and place names on each site.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppV2 } from "./AppV2";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/hud.css";
import "./places.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppV2 />
  </StrictMode>,
);
