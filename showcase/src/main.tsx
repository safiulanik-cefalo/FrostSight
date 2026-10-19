import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { Perf } from "./scenery/Perf";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/hud.css";
import "./scenery/places.css";

// ?perf shows frame rate, draw calls and triangles on a 3D site
const perf = new URLSearchParams(window.location.search).has("perf");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {perf && <Perf />}
  </StrictMode>,
);
