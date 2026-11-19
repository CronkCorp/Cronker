import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
// The IBM Plex faces, bundled from npm and served by Cronk itself: never from a CDN (docs/ui.md).
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/400-italic.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
