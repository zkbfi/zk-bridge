import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The app's tokens, themes, header, bands, rows and search sheet; then the docs' own body type.
import "@web/bridge/bridge.css";
import "@web/explore/explore.css";
import "./docs.css";
import { DocsSite } from "./DocsSite";
import { SITE_PAGES } from "./pages";

const root = document.getElementById("root");
if (root === null) throw new Error("The page has no element with the identifier root.");

createRoot(root).render(
  <StrictMode>
    <DocsSite pages={SITE_PAGES} />
  </StrictMode>,
);
