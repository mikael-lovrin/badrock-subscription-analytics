import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// HashRouter (not BrowserRouter) on purpose: the site is deployed as a
// static GitHub Pages build with a relative `base: "./"` (see
// vite.config.ts) so it works regardless of the repo name or whether it's
// served from a project subpath or a custom domain. A hash-based router
// needs no basename configuration to match that — a path-based
// BrowserRouter would need to know the exact deployed subpath up front.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
